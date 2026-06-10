# Rossmann Watcher

Prueft alle 15 Minuten per GitHub Actions, ob bestimmte Pokemon-Produkte in
Rossmann-Filialen im Raum Radeberg/Dresden (inkl. Bernsdorf) vorraetig sind, und
schickt bei Bestand eine Pushover-Notification aufs Handy. Mehrere Produkte
parallel moeglich (siehe `PRODUCTS` in `check.mjs`).

## Einrichtung (einmalig)

1. Dieses Repo unter dem eigenen GitHub-Account anlegen (oeffentlich).
2. Dateien hochladen (`check.mjs`, `package.json`, `.github/workflows/check.yml`).
3. Unter **Settings -> Secrets and variables -> Actions** zwei Secrets anlegen:
   - `PUSHOVER_USER` = Pushover User Key
   - `PUSHOVER_TOKEN` = Pushover Application API Token
4. Unter **Actions** den Workflow "Rossmann Watcher" aktivieren und einmal
   manuell per **Run workflow** testen.

## Was anpassen, wenn ein anderes Produkt ueberwacht werden soll

In `check.mjs` oben im `PRODUCTS`-Array pro Produkt ein Objekt ergaenzen:

- `dan` = Rossmann-Artikelnummer. Auf der Produktseite auf "Filiale finden"
  klicken, im Netzwerk-Tab den Call `storefinder/.rest/store?dan=...` ablesen.
- `url` = Produktseiten-Link (Button "Zur Produktseite" im Push)
- `name` = kurzer Anzeigename fuer die Notification

`SEED_PLZ` = Liste der Start-PLZ fuer die Umkreissuche (gilt fuer alle Produkte).
