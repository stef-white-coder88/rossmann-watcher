// Rossmann-Verfuegbarkeits-Watcher
// Prueft per Headless-Browser die Filial-Verfuegbarkeit eines Produkts und
// schickt Pushover-Notifications nach folgender Regel:
//   - Pro Filiale wird der zuletzt gesehene Bestand gemerkt (state.json).
//   - Springt eine Filiale von 0 auf >0 (frisch verfuegbar), gibt es EINEN Push.
//   - Bleibt sie verfuegbar, ist Ruhe. Faellt sie auf 0 und kommt spaeter wieder
//     Ware, loest derselbe 0->>0-Sprung erneut aus.
//   - Liefert die Seite gar keine Daten (Bot-Schutz/Netz), gibt es genau EINE
//     "Watcher down"-Meldung, danach Ruhe bis er sich wieder faengt.
// So bleibt der Alarm pro Markt scharf, statt nach 3 globalen Pushes zu
// verstummen, solange irgendwo im Umkreis noch Restbestand liegt.

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
const SEED_PLZ = ['01454', '01067', '01307', '01445', '01900', '02994'];

const STATE_FILE = 'state.json';

const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;

// --- State laden / speichern -------------------------------------------------
// Schema: { stores: { "<filialId>": { city, street, stock } }, down: bool }
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { stores: s.stores && typeof s.stores === 'object' ? s.stores : {}, down: !!s.down };
  } catch {
    return { stores: {}, down: false };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// --- Pushover ----------------------------------------------------------------
function sendPushover({ title, message, url, priority = '1' }) {
  return new Promise((resolve, reject) => {
    const fields = { token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title, message, priority };
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
        id: s.id,
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

  const state = loadState();

  // Schutz: keine Daten = Bot-Schutz/Netzproblem. NICHT als "ausverkauft"
  // werten (sonst Fehlalarme). Stattdessen EINE Down-Meldung, Filial-State
  // unveraendert lassen.
  if (all.length === 0) {
    console.error('Warnung: keine Filialdaten erhalten (Challenge nicht geloest?).');
    if (!state.down) {
      try {
        await sendPushover({
          title: 'Rossmann-Watcher: keine Daten',
          message:
            'Der Watcher bekommt gerade keine Filialdaten (Bot-Schutz oder Netzproblem). ' +
            'Verfuegbarkeit kann aktuell nicht geprueft werden.',
          priority: '0',
        });
        console.log('Down-Push gesendet.');
      } catch (e) {
        console.error('Down-Push fehlgeschlagen:', e.message);
      }
    } else {
      console.log('War schon down - keine weitere Down-Meldung.');
    }
    saveState({ stores: state.stores, down: true });
    process.exit(1);
  }

  // --- Melde-Logik pro Filiale -----------------------------------------------
  const prevStores = state.stores;
  const nextStores = {};
  const newlyAvailable = [];

  for (const s of all) {
    const prevStock = prevStores[s.id]?.stock ?? 0;
    if (prevStock === 0 && s.stock > 0) {
      newlyAvailable.push(s);
    }
    nextStores[s.id] = { city: s.city, street: s.street, stock: s.stock };
  }

  if (newlyAvailable.length > 0) {
    const lines = newlyAvailable
      .map((s) => `- ${s.city}, ${s.street} (${s.stock} Stk)`)
      .join('\n');
    const title =
      newlyAvailable.length === 1
        ? `Pokemon Mini Tin: ${newlyAvailable[0].city} jetzt verfuegbar!`
        : `Pokemon Mini Tin: ${newlyAvailable.length} Filialen jetzt verfuegbar!`;
    await sendPushover({ title, message: `Frisch verfuegbar:\n${lines}`, url: PRODUCT_URL });
    console.log(`Verfuegbar-Push gesendet (${newlyAvailable.length} neue Filiale[n]).`);
  } else {
    console.log('Keine neu verfuegbaren Filialen - keine Notification.');
  }

  saveState({ stores: nextStores, down: false });
  console.log(`State gespeichert: ${Object.keys(nextStores).length} Filialen, down=false`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
