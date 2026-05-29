// Rossmann-Verfuegbarkeits-Watcher
// Prueft per Headless-Browser die Filial-Verfuegbarkeit eines Produkts und
// schickt eine Pushover-Notification, sobald irgendwo Bestand > 0 ist.

import { chromium } from 'playwright';
import https from 'node:https';

// --- Was wird ueberwacht -----------------------------------------------------
const DAN = '084175'; // Rossmann-Artikelnummer der Pokemon TCG Mini Tin
const PRODUCT_URL =
  'https://www.rossmann.de/de/ideenwelt-amigo-pokemon-tcg-mini-tin/p/4007396203073';

// Startpunkte fuer die Filialsuche (Raum Radeberg/Dresden). Pro PLZ liefert
// Rossmann die naechstgelegenen Maerkte; ueber mehrere PLZ + Dedup nach Filial-ID
// decken wir einen groesseren Umkreis ab.
const SEED_PLZ = ['01454', '01067', '01307', '01445', '01900'];

const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;

// --- Pushover ----------------------------------------------------------------
function sendPushover({ title, message, url }) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title,
      message,
      url,
      url_title: 'Zur Produktseite',
      priority: '1', // hohe Prioritaet -> kommt sicher durch
    }).toString();

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

  if (all.length === 0) {
    console.error('Warnung: keine Filialdaten erhalten (Challenge nicht geloest?).');
    process.exit(1); // sichtbar machen, falls der Bot-Schutz dauerhaft blockt
  }

  if (inStock.length > 0) {
    const lines = inStock
      .map((s) => `- ${s.city}, ${s.street} (${s.stock} Stk)`)
      .join('\n');
    await sendPushover({
      title: 'Pokemon Mini Tin verfuegbar!',
      message: `Bestand bei Rossmann:\n${lines}`,
      url: PRODUCT_URL,
    });
    console.log('Pushover gesendet.');
  } else {
    console.log('Kein Bestand - keine Notification.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
