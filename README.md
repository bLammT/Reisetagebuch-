# Reisekarte (Prototyp)

Web-App zum Planen einer Reise auf einer Karte:

- **Übernachtung pro Nacht**: Für jeden Tag trägst du ein, wo du schläfst. Aufeinanderfolgende Nächte am selben Ort werden auf der Karte zu einem Pin zusammengefasst (z. B. „Meran N1–3“).
- **Ausflüge pro Tag**: Start (Unterkunft oder anderer Ort), beliebig viele Zwischenstopps, Ziel, Rundtour ja/nein, Verkehrsmittel (Auto, Fahrrad, zu Fuß).
- **Ortswechsel**: Ziehst du in eine neue Unterkunft um, zeichnet die App die Fahrt dorthin automatisch ein. Das passiert nicht, wenn an diesem Tag schon ein einfacher Ausflug (keine Rundtour) bei der neuen Unterkunft endet.
- **Karte**: Jeder Tag hat eine eigene Farbe. Ein Klick auf „Tag N“ hebt den Tag hervor und zoomt hin. Strecke und Fahrzeit stehen bei jedem Ausflug.
- **Tagebuch**: pro Tag beliebig viele Einträge mit Text, Fotos und optionalem Ort („Mein Standort“ per GPS). Einträge mit Ort erscheinen als ✎-Pin auf der Karte.
- **Speichern**: automatisch im Browser (Reiseplan und Texte in localStorage, Fotos verkleinert in IndexedDB). „Exportieren“ erstellt eine Sicherung inklusive Fotos; „Importieren“ stellt sie wieder her. Wird nur ein Reiseplan ohne Tagebuch importiert, bleibt das vorhandene Tagebuch erhalten.
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
| Routen | FOSSGIS-OSRM (`routing.openstreetmap.de`, Profile `routed-car`, `routed-bike`, `routed-foot`) | Öffentlicher Dienst mit Fair-Use-Regeln. Antwortet er nicht, zeigt die App die Luftlinie (gestrichelt) |

Die genauen Nutzungsbedingungen bitte direkt bei den Anbietern nachlesen, bevor die App öffentlich geht.
Für ein echtes Produkt brauchst du eigene oder bezahlte Dienste, z. B. MapTiler, Stadia Maps, Mapbox, OpenRouteService oder einen selbst betriebenen OSRM- bzw. Valhalla-Server.

**Ohne Internet** funktioniert die Planung trotzdem: Orte lassen sich per „Karte“ anklicken oder als Koordinaten eingeben (z. B. `46.67, 11.15`).

## Ideen für die nächsten Schritte

- Reihenfolge der Ausflüge innerhalb eines Tages per Drag & Drop ändern
- Mehrere Reisen verwalten
- Höhenprofil und Wanderwege (eigene Karte, z. B. OpenTopoMap)
- Sync zwischen Geräten (Backend oder z. B. Supabase/Firebase)
- Als installierbare PWA oder native App (React Native / Flutter)
