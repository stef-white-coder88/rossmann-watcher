// Rossmann-Verfuegbarkeits-Watcher
// Prueft per Headless-Browser die Filial-Verfuegbarkeit MEHRERER Produkte und
// schickt Pushover-Notifications nach folgender Regel:
//   - Pro Produkt UND Filiale wird der zuletzt gesehene Bestand gemerkt
//     (state.json, nach DAN verschachtelt).
//   - Springt eine Filiale von 0 auf >0 (frisch verfuegbar), gibt es EINEN Push.
//   - Bleibt sie verfuegbar, ist Ruhe. Faellt sie auf 0 und kommt spaeter wieder
//     Ware, loest derselbe 0->>0-Sprung erneut aus.
//   - Liefert die Seite gar keine Daten (Bot-Schutz/Netz), gibt es genau EINE
//     "Watcher down"-Meldung, danach Ruhe bis er sich wieder faengt.
// So bleibt der Alarm pro Produkt+Markt scharf, statt nach 3 globalen Pushes zu
// verstummen, solange irgendwo im Umkreis noch Restbestand liegt.

import { chromium } from 'playwright';
import https from 'node:https';
import fs from 'node:fs';

// --- Was wird ueberwacht -----------------------------------------------------
// dan  = Rossmann-Artikelnummer (steht im Netzwerk-Call
//        storefinder/.rest/store?dan=...; auf der Produktseite per Klick auf
//        "Filiale finden" sichtbar)
// url  = Produktseiten-Link (fuer den Push-Button "Zur Produktseite")
// name = kurzer Anzeigename fuer die Notification
const PRODUCTS = [
  {
    dan: '084175',
    name: 'Pokemon Mini Tin',
    url: 'https://www.rossmann.de/de/ideenwelt-amigo-pokemon-tcg-mini-tin/p/4007396203073',
  },
  {
    dan: '516372',
    name: 'Pokemon Booster Nr. 1',
    url: 'https://www.rossmann.de/de/baby-und-spielzeug-amigo-pokemon-booster-nr-1/p/0820650250170',
  },
];

// Startpunkte fuer die Filialsuche (Raum Radeberg/Dresden + Bernsdorf). Pro PLZ
// liefert Rossmann die naechstgelegenen Maerkte; ueber mehrere PLZ + Dedup nach
// Filial-ID decken wir einen groesseren Umkreis ab.
const SEED_PLZ = ['01454', '01067', '01307', '01445', '01900', '02994'];

const STATE_FILE = 'state.json';

const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;

// --- State laden / speichern -------------------------------------------------
// Schema: { products: { "<dan>": { "<filialId>": { city, street, stock } } }, down: bool }
// Migration: altes flaches Schema { stores: {...}, down } wird dem ersten Produkt
// (Mini Tin, dan 084175) zugeordnet, damit dessen Pro-Filial-Gedaechtnis erhalten
// bleibt und kein Fehlalarm-Schwall entsteht.
const LEGACY_DAN = '084175';

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.stores && !s.products) {
      return { products: { [LEGACY_DAN]: s.stores }, down: !!s.down };
    }
    return {
      products: s.products && typeof s.products === 'object' ? s.products : {},
      down: !!s.down,
    };
  } catch {
    return { products: {}, down: false };
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

// --- Storefinder pro Produkt abfragen ----------------------------------------
// Liefert { stores, okCount } fuer EIN Produkt:
//   stores  = Map filialId -> { id, city, postcode, street, stock }, ueber alle
//             Seed-PLZ dedupliziert
//   okCount = Anzahl Seed-PLZ, die valide JSON lieferten. okCount === 0 heisst
//             "fuer dieses Produkt gar keine Daten" (Bot-Schutz/Netz) und ist
//             klar von "valide Antwort, aber 0 Stueck" zu unterscheiden -> der
//             Aufrufer darf bei okCount === 0 NICHT auf ausverkauft schliessen.
async function fetchStoresForProduct(page, dan) {
  const stores = new Map();
  let okCount = 0;
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
      { dan, plz }
    );

    if (!result.ok || !result.data || !Array.isArray(result.data.store)) {
      console.error(
        `[${dan}] PLZ ${plz}: keine JSON-Antwort (${result.snippet || 'kein store-Array'})`
      );
      continue;
    }
    okCount++;
    for (const s of result.data.store) {
      // tolerant vergleichen: API liefert dan mal als String mit fuehrender
      // Null ("084175"), mal evtl. als Number -> ueber String() angleichen.
      const info = (s.productInfo || []).find((p) => String(p.dan) === String(dan));
      const stock = info ? parseInt(info.stock, 10) || 0 : 0;
      stores.set(s.id, { id: s.id, city: s.city, postcode: s.postcode, street: s.street, stock });
    }
  }
  return { stores, okCount };
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

  // Irgendeine Produktseite laden -> der Bot-Schutz (Fastly-Challenge) wird vom
  // echten Browser geloest und setzt die Cookies, die der Storefinder-Call dann
  // im Seitenkontext mittraegt. Eine Challenge-Loesung gilt fuer alle Produkte.
  await page.goto(PRODUCTS[0].url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 20; i++) {
    const title = await page.title();
    if (!/challenge/i.test(title)) break;
    await page.waitForTimeout(1500);
  }

  // Pro Produkt die Filialen einsammeln.
  const perProduct = [];
  for (const product of PRODUCTS) {
    const { stores, okCount } = await fetchStoresForProduct(page, product.dan);
    perProduct.push({ product, all: [...stores.values()], okCount });
  }

  await browser.close();

  for (const { product, all } of perProduct) {
    const inStock = all.filter((s) => s.stock > 0);
    console.log(`\n[${product.name}] Geprueft: ${all.length} Filialen, mit Bestand: ${inStock.length}`);
    for (const s of all) {
      console.log(
        `  ${s.stock > 0 ? '[x]' : '[ ]'} ${s.postcode} ${s.city}, ${s.street}: stock=${s.stock}`
      );
    }
  }

  const state = loadState();
  const allFailed = perProduct.every((p) => p.okCount === 0);

  // Schutz: gar keine Daten ueber ALLE Produkte = Bot-Schutz/Netzproblem. NICHT
  // als "ausverkauft" werten (sonst Fehlalarme). Stattdessen EINE Down-Meldung,
  // Filial-State unveraendert lassen. Teil-Ausfaelle (ein Produkt liefert, eins
  // nicht) werden weiter unten pro Produkt abgefangen.
  if (allFailed) {
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
    saveState({ products: state.products, down: true });
    process.exit(1);
  }

  // --- Melde-Logik pro Produkt + Filiale -------------------------------------
  const nextProducts = {};

  for (const { product, all, okCount } of perProduct) {
    const prevStores = state.products[product.dan] || {};

    // Teil-Ausfall: dieses Produkt lieferte keine valide Antwort. Alten Stand
    // unveraendert halten (nicht auf {} ueberschreiben), sonst entsteht beim
    // Wiederauftauchen ein Fehlalarm-Schwall. Kein Push.
    if (okCount === 0) {
      nextProducts[product.dan] = prevStores;
      console.log(`[${product.name}] Keine Daten (Ausfall) - State unveraendert gehalten.`);
      continue;
    }

    const nextStores = {};
    const newlyAvailable = [];
    for (const s of all) {
      const prevStock = prevStores[s.id]?.stock ?? 0;
      if (prevStock === 0 && s.stock > 0) newlyAvailable.push(s);
      nextStores[s.id] = { city: s.city, street: s.street, stock: s.stock };
    }

    if (newlyAvailable.length === 0) {
      nextProducts[product.dan] = nextStores;
      console.log(`[${product.name}] Keine neu verfuegbaren Filialen - keine Notification.`);
      continue;
    }

    const lines = newlyAvailable.map((s) => `- ${s.city}, ${s.street} (${s.stock} Stk)`).join('\n');
    const title =
      newlyAvailable.length === 1
        ? `${product.name}: ${newlyAvailable[0].city} jetzt verfuegbar!`
        : `${product.name}: ${newlyAvailable.length} Filialen jetzt verfuegbar!`;
    try {
      await sendPushover({ title, message: `Frisch verfuegbar:\n${lines}`, url: product.url });
      // Erst nach erfolgreichem Push den neuen Stand uebernehmen.
      nextProducts[product.dan] = nextStores;
      console.log(`[${product.name}] Verfuegbar-Push gesendet (${newlyAvailable.length} neue Filiale[n]).`);
    } catch (e) {
      // Push fehlgeschlagen: alten Stand halten, damit nur DIESES Produkt im
      // naechsten Lauf erneut gemeldet wird und bereits erfolgreiche Produkte
      // nicht doppelt pushen.
      nextProducts[product.dan] = prevStores;
      console.error(`[${product.name}] Push fehlgeschlagen, State gehalten:`, e.message);
    }
  }

  saveState({ products: nextProducts, down: false });
  console.log(`\nState gespeichert: ${PRODUCTS.length} Produkte, down=false`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
