// Rossmann-Verfuegbarkeits-Watcher
// Prueft per Headless-Browser die Filial-Verfuegbarkeit eines Produkts und
// schickt Pushover-Notifications nach folgender Regel:
//   - Sobald irgendwo Bestand > 0 ist: bis zu 3x melden (alle 15 Min), dann Ruhe.
//   - Wenn danach wieder ausverkauft: EINE "wieder ausverkauft"-Meldung.
//   - Kommt erneut Ware: der 3er-Zyklus startet von vorn.
// Der Melde-Zustand wird in state.json zwischen den Laeufen gemerkt.

import { chromium } from 'playwright';
import https from 'node:https';
import fs from 'node:fs';

// --- Was wird ueberwacht -----------------------------------------------------
const DAN = '084175'; // Rossmann-Artikelnummer der Pokemon TCG Mini Tin
const PRODUCT_URL =
  'https://www.rossmann.de/de/ideenwelt-amigo-pokemon-tcg-mini-tin/p/4007396203073';

// Startpunkte fuer die Filialsuche (Raum Radeberg/Dresden). Pro PLZ liefert
// Rossmann die naechstgelegenen Maerkte; ueber mehrere PLZ + Dedup nach Filial-ID
// decken wir einen groesseren Umkreis ab.
const SEED_PLZ = ['01454', '01067', '01307', '01445', '01900'];

const MAX_NOTIFY = 3; // wie oft pro Verfuegbarkeits-Phase melden
const STATE_FILE = 'state.json';

const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;

// --- State laden / speichern -------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { inStock: false, notifyCount: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// --- Pushover ----------------------------------------------------------------
function sendPushover({ title, message, url }) {
  return new Promise((resolve, reject) => {
    const fields = { token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title, message, priority: '1' };
    if (url) {
      fields.url = url;
      fields.url_title = 'Zur Produktseite';
    }
    const body = new URLSearchParams(fields).toString();

    const req = https.request(
      'https://api.pushover.net/1/messages.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          res.statusCode === 200
            ? resolve(data)
            : reject(new Error(`Pushover ${res.statusCode}: ${data}`))
        );
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Hauptlauf ---------------------------------------------------------------
async function main() {
  if (!PUSHOVER_USER || !PUSHOVER_TOKEN) {
    console.error('FEHLER: PUSHOVER_USER / PUSHOVER_TOKEN nicht gesetzt.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'de-DE',
  });
  const page = await ctx.newPage();

  // Produktseite laden -> der Bot-Schutz (Fastly-Challenge) wird vom echten
  // Browser automatisch geloest und die Seite laedt sich danach neu.
  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 20; i++) {
    const title = await page.title();
    if (!/challenge/i.test(title)) break;
    await page.waitForTimeout(1500);
  }

  // Storefinder pro Seed-PLZ abfragen (im Seitenkontext -> traegt die Cookies,
  // die die Challenge gesetzt hat).
  const stores = new Map();
  for (const plz of SEED_PLZ) {
    const result = await page.evaluate(
      async ({ dan, plz }) => {
        try {
          const r = await fetch(`/storefinder/.rest/store?dan=${dan}&q=${plz}`, {
            headers: { Accept: 'application/json' },
            credentials: 'include',
          });
          const text = await r.text();
          try {
            return { ok: true, data: JSON.parse(text) };
          } catch {
            return { ok: false, snippet: text.slice(0, 120) };
          }
        } catch (e) {
          return { ok: false, snippet: String(e) };
        }
      },
      { dan: DAN, plz }
    );

    if (!result.ok || !result.data || !Array.isArray(result.data.store)) {
      console.error(`PLZ ${plz}: keine JSON-Antwort (${result.snippet || 'kein store-Array'})`);
      continue;
    }
    for (const s of result.data.store) {
      const info = (s.productInfo || []).find((p) => p.dan === DAN);
      const stock = info ? parseInt(info.stock, 10) || 0 : 0;
      stores.set(s.id, {
        city: s.city,
        postcode: s.postcode,
        street: s.street,
        stock,
      });
    }
  }

  await browser.close();

  const all = [...stores.values()];
  const inStock = all.filter((s) => s.stock > 0);

  console.log(`Geprueft: ${all.length} Filialen, mit Bestand: ${inStock.length}`);
  for (const s of all) {
    console.log(
      `  ${s.stock > 0 ? '[x]' : '[ ]'} ${s.postcode} ${s.city}, ${s.street}: stock=${s.stock}`
    );
  }

  // Schutz: keine Daten = Bot-Schutz/Netzproblem. NICHT als "ausverkauft"
  // werten, sonst gibt es Fehlalarme. State unveraendert lassen.
  if (all.length === 0) {
    console.error('Warnung: keine Filialdaten erhalten (Challenge nicht geloest?).');
    process.exit(1);
  }

  // --- Melde-Logik mit Gedaechtnis -------------------------------------------
  const prev = loadState();
  const next = { inStock: prev.inStock, notifyCount: prev.notifyCount };

  if (inStock.length > 0) {
    // Neue Verfuegbarkeits-Phase? -> Zaehler zuruecksetzen
    if (!prev.inStock) {
      next.notifyCount = 0;
      console.log('Neue Verfuegbarkeits-Phase erkannt.');
    }
    next.inStock = true;

    if (next.notifyCount < MAX_NOTIFY) {
      next.notifyCount += 1;
      const lines = inStock.map((s) => `- ${s.city}, ${s.street} (${s.stock} Stk)`).join('\n');
      await sendPushover({
        title: `Pokemon Mini Tin verfuegbar! (${next.notifyCount}/${MAX_NOTIFY})`,
        message: `Bestand bei Rossmann:\n${lines}`,
        url: PRODUCT_URL,
      });
      console.log(`Verfuegbar-Push gesendet (${next.notifyCount}/${MAX_NOTIFY}).`);
    } else {
      console.log(`Bereits ${MAX_NOTIFY}x gemeldet - keine weitere Push.`);
    }
  } else {
    // Nichts verfuegbar
    if (prev.inStock) {
      // Uebergang verfuegbar -> ausverkauft: einmal Bescheid geben
      await sendPushover({
        title: 'Wieder ausverkauft',
        message: 'Die Pokemon Mini Tin ist in den ueberwachten Filialen nicht mehr verfuegbar.',
        url: PRODUCT_URL,
      });
      console.log('Ausverkauft-Push gesendet.');
    } else {
      console.log('Kein Bestand - keine Notification.');
    }
    next.inStock = false;
    next.notifyCount = 0;
  }

  saveState(next);
  console.log(`State: ${JSON.stringify(next)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
