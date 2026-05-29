# Rossmann Watcher

Prueft alle 15 Minuten per GitHub Actions, ob eine Pokemon TCG Mini Tin in
Rossmann-Filialen im Raum Radeberg/Dresden vorraetig ist, und schickt bei
Bestand eine Pushover-Notification aufs Handy.

## Einrichtung (einmalig)

1. Dieses Repo unter dem eigenen GitHub-Account anlegen (oeffentlich).
2. Dateien hochladen (`check.mjs`, `package.json`, `.github/workflows/check.yml`).
3. Unter **Settings -> Secrets and variables -> Actions** zwei Secrets anlegen:
   - `PUSHOVER_USER` = Pushover User Key
   - `PUSHOVER_TOKEN` = Pushover Application API Token
4. Unter **Actions** den Workflow "Rossmann Watcher" aktivieren und einmal
   manuell per **Run workflow** testen.

## Was anpassen, wenn ein anderes Produkt ueberwacht werden soll

In `check.mjs` oben:

- `DAN` = Rossmann-Artikelnummer (steht im Netzwerk-Call `storefinder/.rest/store?dan=...`)
- `PRODUCT_URL` = Produktseiten-Link
- `SEED_PLZ` = Liste der Start-PLZ fuer die Umkreissuche
