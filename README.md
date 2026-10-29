# Story Board

Eine schlanke Übersicht für User Stories in der Produktentwicklung – als Board mit Spalten, optimiert fürs Smartphone. Node.js-Server mit Postgres, ohne Build-Schritt fürs Frontend, fertig für Coolify.

## Funktionen

- **Spalten-Board** (Standard: Backlog · Bereit · In Arbeit · Review · Fertig), Spalten frei umbenennbar, hinzufügen, löschen
- **Helles, ruhiges Design** im Stil von Linear: Status-Icons pro Spalte, Prioritäts-Balken, farbige Epics, Story-IDs (US-1, US-2 …)
- **User Stories** im Format *„Als … möchte ich … damit …"* mit Akzeptanzkriterien, MoSCoW-Priorität, Story Points (Fibonacci) und Epic
- **Sortierung** manuell, nach Priorität, Story Points, Epic, Datum oder Titel – plus Suche und Epic-Filter
- **Verschieben** per Drag & Drop (Desktop) oder Pfeiltasten auf der Karte (Mobil)
- **Einfaches Passwort** statt Login; Sitzung bleibt 30 Tage pro Gerät bestehen
- **Branding direkt in der Oberfläche**: Produktname, Primärfarbe und Logo (⚙︎ oben rechts)
- **Mobil**: eine Spalte pro Bildschirm mit Wischen und Tabs, Bottom-Sheets, Dunkelmodus, „Zum Home-Bildschirm" möglich
- **Postgres** als Speicher – alle Geräte sehen denselben Stand; Export/Import als JSON-Backup
- **Markdown-Export** fürs ganze Board (Symbol oben rechts) oder pro Spalte (Pfeil im Spaltenkopf) – als `.md`-Datei oder direkt in die Zwischenablage, z. B. zum Weiterarbeiten in Claude. Exportiert immer alle Stories, in der gewählten Sortierung

## Deployment auf Coolify

**1. Datenbank anlegen**
Im Projekt → *+ New* → *Database* → *PostgreSQL* → starten. In den Datenbank-Einstellungen die **Postgres URL (internal)** kopieren.

**2. App anlegen**
*+ New* → *Private Repository (with GitHub App)* → dieses Repo und den Branch `main` wählen.
- **Build Pack:** `Dockerfile`
- **Ports Exposes:** `3000`
- **Domain:** z. B. `https://stories.deinedomain.de` (Coolify holt das TLS-Zertifikat automatisch)

**3. Umgebungsvariablen** (Tab *Environment Variables*)

| Variable | Wert | Pflicht |
|---|---|---|
| `DATABASE_URL` | die interne Postgres-URL aus Schritt 1 | ja |
| `APP_PASSWORD` | dein Passwort für die App | ja |
| `DATABASE_SSL` | `true`, nur falls die DB ausschließlich per TLS erreichbar ist | nein |
| `SESSION_SECRET` | eigener Schlüssel für Sitzungen; leer = wird automatisch erzeugt | nein |

**4. Deploy** klicken. Beim ersten Start legt die App die Tabellen an und füllt das Board mit ein paar Beispiel-Stories. Health-Check: `GET /health`.

Danach in Coolify gern *Auto Deploy* aktiv lassen – jeder Push auf `main` wird automatisch ausgerollt.

### Hinweise

- Wird das Passwort in der App geändert, gilt ab dann dieses (gespeichert als scrypt-Hash in der DB) und `APP_PASSWORD` wird ignoriert. Alle anderen Geräte werden dabei abgemeldet.
- **Passwort vergessen?** Mit einem SQL-Client auf die DB: `DELETE FROM settings WHERE key = 'password';` – danach gilt wieder `APP_PASSWORD`.
- **Backups:** In Coolify bei der Datenbank unter *Backups* einen Zeitplan einrichten (optional S3). Zusätzlich gibt es in der App *Einstellungen → Exportieren*.
- Das Passwort ist ein einfacher gemeinsamer Zugangsschutz, keine Benutzerverwaltung. Fehlversuche sind auf 10 pro IP in 15 Minuten begrenzt.

## Lokal entwickeln

Mit Docker:

```bash
docker compose up --build      # http://localhost:3000, Passwort: demo
```

Oder mit einer vorhandenen Postgres:

```bash
cp .env.example .env           # DATABASE_URL und APP_PASSWORD anpassen
npm install
npm run dev
```

## Aufbau

| Pfad | Inhalt |
|---|---|
| `server/index.js` | Express-Server, REST-API, Auslieferung des Frontends |
| `server/db.js` | Postgres-Verbindung, Schema-Migration, Beispieldaten |
| `server/auth.js` | Passwortprüfung, signiertes Sitzungs-Cookie, Login-Limit |
| `public/` | Frontend (HTML, CSS, JavaScript) |
| `Dockerfile` | Image für Coolify |
| `docker-compose.yml` | Lokale Entwicklung mit Postgres |

### API

Alle Routen unter `/api` außer `session` und `login` erfordern eine Sitzung.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/session` | Anmeldestatus und Branding |
| POST | `/api/login` · `/api/logout` | An-/Abmelden |
| GET | `/api/board` | Spalten, Stories, Einstellungen |
| POST | `/api/stories` | Story anlegen |
| PATCH · DELETE | `/api/stories/:id` | Story ändern · löschen |
| POST | `/api/stories/:id/move` | In Spalte/Position verschieben |
| PUT | `/api/settings` · `/api/columns` · `/api/password` | Branding · Spalten · Passwort |
| GET · POST | `/api/export` · `/api/import` | JSON-Backup |
