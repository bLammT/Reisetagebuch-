# Reisekarte (Prototyp)

Web-App zum Planen einer Reise auf einer Karte:

- **Übernachtung pro Nacht**: Für jeden Tag trägst du ein, wo du schläfst. Mit „Nächte hier −/+“ legst du mehrere Nächte am selben Ort auf einmal fest. Aufeinanderfolgende Nächte am selben Ort werden auf der Karte zu einem Pin zusammengefasst (z. B. „Meran N1–3“).
- **Nacht unterwegs**: Nachtzug, Nachtbus, Fähre, Flug oder Auto mit Abfahrts- und Ankunftsort. Ohne Abfahrtsort gilt der Ort, an dem man morgens war; am nächsten Morgen startet man am Ankunftsort.
- **Tage ordnen**: Tage am Griff ⠿ verschieben (Maus, Finger oder Pfeiltasten), „+ Tag einfügen“ zwischen den Tagen und „+ Tag am Anfang“ (dann wird die Anreise einen Tag früher, die übrigen Tage behalten ihr Datum).
- **Ausflüge pro Tag**: Start (Unterkunft oder anderer Ort), beliebig viele Zwischenstopps, Ziel, Rundtour ja/nein, Verkehrsmittel (Auto, Fahrrad, zu Fuß).
- **Ortswechsel**: Ziehst du in eine neue Unterkunft um, zeichnet die App die Fahrt dorthin automatisch ein. Das passiert nicht, wenn an diesem Tag schon ein einfacher Ausflug (keine Rundtour) bei der neuen Unterkunft endet.
- **Karte**: Jeder Tag hat eine eigene Farbe. Ein Klick auf „Tag N“ hebt den Tag hervor und zoomt hin. Strecke und Fahrzeit stehen bei jedem Ausflug. Beim Scrollen der Liste zeigt die Karte den Tag, der gerade oben steht (abschaltbar mit „Folgt der Liste“). Ein Klick auf Linie, Pin oder Eintrag in der Karte springt in der Liste dorthin.
- **Tagebuch**: pro Tag beliebig viele Einträge mit Text, Fotos, Links (z. B. ein geteiltes Google-Fotos-Album) und optionalem Ort („Mein Standort“ per GPS). Einträge mit Ort erscheinen als ✎-Pin auf der Karte.
- **Speichern**: automatisch im Browser (Reiseplan und Texte in localStorage, Fotos verkleinert in IndexedDB). „Exportieren“ erstellt eine Sicherung inklusive Fotos; „Importieren“ stellt sie wieder her. Wird nur ein Reiseplan ohne Tagebuch importiert, bleibt das vorhandene Tagebuch erhalten.
- **Online-Sync (optional)**: Mit eigenem Server (Home-Assistant-Add-on „Reisetagebuch Server“, siehe [bLammT/ha-addons](https://github.com/bLammT/ha-addons)) und Login ist die Reise auf allen Geräten gleich und lässt sich mit Mitreisenden teilen. Änderungen gehen kurz verzögert an den Server; offline wird später nachgeholt. Wurde die Reise woanders geändert, während hier noch ungespeicherte Änderungen liegen, fragt die App, welcher Stand gilt. Fotos werden mit hochgeladen (ab Add-on-Version 0.2.0) und auf anderen Geräten bei Bedarf geladen.
- **Handy**: installierbar auf dem Startbildschirm (PWA) und startet auch offline. Die Karte selbst braucht Internet.

## Starten

Es gibt keinen Build-Schritt. Die Seite muss aber über einen lokalen Webserver laufen, nicht als `file://`:

```bash
cd reise-karte
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst: Seitenleiste und Karte |
| `styles.css` | Gestaltung inkl. Handy-Layout und Dunkelmodus |
| `app.js` | Datenmodell, Rendering, Karte, Ortssuche, Routing |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline-Start und Installation auf dem Handy |
| `vendor/leaflet/` | Leaflet 1.9.4 (Kartenbibliothek, BSD-2-Lizenz) |
| `vendor/pocketbase/` | PocketBase JS-SDK 0.28.1 für den Online-Sync (MIT-Lizenz) |

Das Datenmodell steht oben in `app.js` als Kommentar.

## Online stellen (für das Handy)

Standort und Installation funktionieren nur über `https://` (oder `localhost`). Kostenlos geht das z. B. mit GitHub Pages:
neues öffentliches Repository anlegen, alle Dateien hochladen (ohne die eigene Reisedatei, wenn sie nicht öffentlich sein soll),
dann unter *Settings → Pages* „Deploy from a branch“, Branch `main`, Ordner `/ (root)` wählen.

## Externe Dienste und ihre Grenzen

| Zweck | Dienst | Hinweis |
|---|---|---|
| Kartenkacheln | `tile.openstreetmap.org` | Laut OSM-Tile-Policy nicht für Apps mit viel Traffic gedacht |
| Ortssuche | Nominatim (`nominatim.openstreetmap.org`) | Höchstens 1 Anfrage pro Sekunde, keine Massenabfragen. Die App hält diese Grenze ein |
| Online-Sync (optional) | eigener PocketBase-Server | Nur wenn im Dialog „Online-Sync“ eine Adresse eingetragen ist. Muss über `https://` erreichbar sein |
| Routen | FOSSGIS-OSRM (`routing.openstreetmap.de`, Profile `routed-car`, `routed-bike`, `routed-foot`) | Öffentlicher Dienst mit Fair-Use-Regeln. Antwortet er nicht, zeigt die App die Luftlinie (gestrichelt) |

Die genauen Nutzungsbedingungen bitte direkt bei den Anbietern nachlesen, bevor die App öffentlich geht.
Für ein echtes Produkt brauchst du eigene oder bezahlte Dienste, z. B. MapTiler, Stadia Maps, Mapbox, OpenRouteService oder einen selbst betriebenen OSRM- bzw. Valhalla-Server.

**Ohne Internet** funktioniert die Planung trotzdem: Orte lassen sich per „Karte“ anklicken oder als Koordinaten eingeben (z. B. `46.67, 11.15`).

## Ideen für die nächsten Schritte

- Reihenfolge der Ausflüge innerhalb eines Tages per Drag & Drop ändern
- Mehrere Reisen verwalten
- Höhenprofil und Wanderwege (eigene Karte, z. B. OpenTopoMap)
- Mitreisende direkt in der App einladen (bisher über die PocketBase-Admin-Oberfläche)
- Als installierbare PWA oder native App (React Native / Flutter)
