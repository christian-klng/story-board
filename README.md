# Story Board

Eine schlanke Übersicht für User Stories in der Produktentwicklung – als Board mit Spalten, optimiert fürs Smartphone. Kein Backend, kein Login, kein Build-Schritt: drei Dateien, die in jedem Browser laufen.

## Funktionen

- **Spalten-Board** (Standard: Backlog · Bereit · In Arbeit · Review · Fertig), Spalten frei umbenennbar
- **User Stories** im klassischen Format *„Als … möchte ich … damit …"* mit Akzeptanzkriterien, MoSCoW-Priorität, Story Points (Fibonacci) und Epic
- **Sortierung** manuell, nach Priorität, Story Points, Epic, Datum oder Titel – plus Suche und Epic-Filter
- **Verschieben** per Drag & Drop (Desktop) oder Pfeiltasten auf der Karte (Mobil)
- **Einfaches Passwort**: wird beim ersten Start festgelegt, gespeichert nur als SHA-256-Hash
- **Branding direkt in der Oberfläche**: Produktname, Primärfarbe und Logo (⚙︎ oben rechts)
- **Mobil**: eine Spalte pro Bildschirm mit Wischen und Tabs, Bottom-Sheets, Dunkelmodus, „Zum Home-Bildschirm" möglich
- **Export/Import** als JSON zum Sichern oder Übertragen auf ein anderes Gerät

## Starten

`index.html` im Browser öffnen – fertig. Oder lokal servieren:

```bash
npx serve .
```

Zum Nutzen auf dem Handy eignet sich jeder statische Hoster (GitHub Pages, Netlify, Cloudflare Pages, Railway …).

## Wichtig zu wissen

- **Daten liegen nur im Browser** (localStorage) des jeweiligen Geräts. Für Backup oder Gerätewechsel: Einstellungen → Exportieren/Importieren.
- **Das Passwort ist eine einfache Sperre**, keine echte Zugriffskontrolle: Wer Zugriff auf das Gerät und die Entwicklerwerkzeuge hat, kommt an die Daten. Für vertrauliche Inhalte bräuchte es ein Backend mit Authentifizierung.
- Passwort vergessen? Einstellungen sind dann nicht erreichbar – im Browser die Website-Daten löschen setzt das Board zurück (Daten gehen dabei verloren, daher regelmäßig exportieren).

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Struktur, Dialoge |
| `style.css` | Layout, mobile Darstellung, Theming über `--primary` |
| `app.js` | Logik: Daten, Passwort, Board, Sortierung, Branding |
| `manifest.webmanifest` | Installierbar als Web-App |
