import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL fehlt. Beispiel: postgres://user:pass@host:5432/storyboard');
  process.exit(1);
}

// Coolify-interne Verbindungen laufen ohne TLS; extern kann DATABASE_SSL=true gesetzt werden.
const ssl = /^(1|true|require)$/i.test(process.env.DATABASE_SSL || '') ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: url, ssl, max: 5 });

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS board_columns (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  position integer NOT NULL
);
CREATE TABLE IF NOT EXISTS stories (
  id         text PRIMARY KEY,
  column_id  text NOT NULL REFERENCES board_columns(id),
  position   integer NOT NULL,
  title      text NOT NULL,
  role       text NOT NULL DEFAULT '',
  want       text NOT NULL DEFAULT '',
  benefit    text NOT NULL DEFAULT '',
  criteria   jsonb NOT NULL DEFAULT '[]',
  priority   text NOT NULL DEFAULT 'could' CHECK (priority IN ('must','should','could','wont')),
  points     integer,
  epic       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stories_column_pos ON stories (column_id, position);
-- v3: fortlaufende Nummer für Story-IDs
ALTER TABLE stories ADD COLUMN IF NOT EXISTS number serial;

-- v4: mehrere Apps. Jede App hat eigenes Branding, eigene Spalten, eigene Stories
-- und eigenes Kürzel mit eigener Zählung (z. B. SHOP-1, CRM-1).
CREATE TABLE IF NOT EXISTS apps (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  prefix      text NOT NULL,
  color       text NOT NULL,
  logo        text NOT NULL DEFAULT '',
  position    integer NOT NULL DEFAULT 0,
  next_number integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS apps_prefix_unique ON apps (upper(prefix));
ALTER TABLE board_columns ADD COLUMN IF NOT EXISTS app_id text REFERENCES apps(id) ON DELETE CASCADE;
ALTER TABLE stories       ADD COLUMN IF NOT EXISTS app_id text REFERENCES apps(id) ON DELETE CASCADE;
`;

// Wird nach der Datenübernahme ausgeführt (dann haben alle Zeilen eine App)
const SCHEMA_AFTER = `
ALTER TABLE board_columns ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE stories       ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE stories       ALTER COLUMN number DROP DEFAULT;
CREATE INDEX IF NOT EXISTS board_columns_app ON board_columns (app_id, position);
CREATE INDEX IF NOT EXISTS stories_app ON stories (app_id);
CREATE UNIQUE INDEX IF NOT EXISTS stories_app_number ON stories (app_id, number);
`;

export const DEFAULT_COLOR = '#5e6ad2';
export const DEFAULT_COLUMNS = ['Backlog', 'Bereit', 'In Arbeit', 'Review', 'Fertig'];

export async function migrate() {
  // Advisory Lock, damit parallele Container (Rolling Deploy) nicht gleichzeitig migrieren
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(424242)');
    await c.query(SCHEMA);
    // v3: alte Standardfarbe auf die neue heben (nur wenn nie geändert)
    await c.query(`UPDATE settings SET value = jsonb_set(value, '{color}', '"#5e6ad2"') WHERE key = 'branding' AND value->>'color' = '#4f46e5'`);

    const { rowCount: hasApps } = await c.query('SELECT 1 FROM apps LIMIT 1');
    if (!hasApps) {
      const { rowCount: hasBoard } = await c.query('SELECT 1 FROM board_columns LIMIT 1');
      if (hasBoard) await adoptExistingBoard(c);
      else await seed(c);
    }
    await c.query(SCHEMA_AFTER);
  });
}

// v4: Das bisherige einzelne Board wird zur ersten App. Kürzel bleibt "US", damit alle IDs gleich bleiben.
async function adoptExistingBoard(c) {
  const { rows } = await c.query(`SELECT value FROM settings WHERE key = 'branding'`);
  const b = rows[0]?.value || {};
  const { rows: [{ max }] } = await c.query('SELECT COALESCE(MAX(number), 0) AS max FROM stories');
  const id = randomUUID();
  await c.query(
    `INSERT INTO apps (id, name, prefix, color, logo, position, next_number) VALUES ($1,$2,'US',$3,$4,0,$5)`,
    [id, b.appName || 'Story Board', /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : DEFAULT_COLOR, b.logo || '', Number(max) + 1],
  );
  await c.query('UPDATE board_columns SET app_id = $1 WHERE app_id IS NULL', [id]);
  await c.query('UPDATE stories SET app_id = $1 WHERE app_id IS NULL', [id]);
  console.log(`Migration: bestehendes Board als App „${b.appName || 'Story Board'}“ (US) übernommen.`);
}

export async function createApp(c, { name, prefix, color, logo = '' }) {
  const id = randomUUID();
  const { rows: [{ pos }] } = await c.query('SELECT COALESCE(MAX(position) + 1, 0) AS pos FROM apps');
  await c.query(
    'INSERT INTO apps (id, name, prefix, color, logo, position) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, name, prefix, color, logo, pos],
  );
  for (const [i, colName] of DEFAULT_COLUMNS.entries()) {
    await c.query('INSERT INTO board_columns (id, app_id, name, position) VALUES ($1,$2,$3,$4)', [randomUUID(), id, colName, i]);
  }
  return id;
}

// Vergibt die nächste Story-Nummer einer App (Zeilensperre verhindert doppelte Nummern)
export async function nextNumber(c, appId) {
  const { rows } = await c.query('UPDATE apps SET next_number = next_number + 1 WHERE id = $1 RETURNING next_number - 1 AS n', [appId]);
  return rows[0].n;
}

async function seed(c) {
  const appId = await createApp(c, { name: 'Story Board', prefix: 'US', color: DEFAULT_COLOR });
  const { rows: cols } = await c.query('SELECT id FROM board_columns WHERE app_id = $1 ORDER BY position', [appId]);
  const examples = [
    ['Konto anlegen', 'neue Nutzerin', 'mich mit E-Mail und Passwort registrieren', 'ich das Produkt nutzen kann', 'must', 3, 'Onboarding', 0, ['Bestätigungsmail wird versendet', 'Passwort mind. 8 Zeichen']],
    ['Passwort zurücksetzen', 'registrierter Nutzer', 'mein Passwort per E-Mail zurücksetzen', 'ich wieder Zugang bekomme', 'should', 2, 'Onboarding', 1, ['Link ist 24 h gültig']],
    ['Dashboard-Übersicht', 'Teamleiterin', 'die wichtigsten Kennzahlen auf einen Blick sehen', 'ich schnell entscheiden kann', 'must', 8, 'Reporting', 2, []],
    ['Export als CSV', 'Analyst', 'Daten als CSV exportieren', 'ich sie in Excel weiterverarbeiten kann', 'could', 3, 'Reporting', 0, []],
  ];
  const pos = {};
  for (const [title, role, want, benefit, priority, points, epic, ci, criteria] of examples) {
    const colId = cols[ci].id;
    pos[colId] = (pos[colId] ?? -1) + 1;
    await c.query(
      `INSERT INTO stories (id, app_id, column_id, position, number, title, role, want, benefit, criteria, priority, points, epic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [randomUUID(), appId, colId, pos[colId], await nextNumber(c, appId), title, role, want, benefit, JSON.stringify(criteria), priority, points, epic],
    );
  }
}

export async function getSetting(key, client = pool) {
  const { rows } = await client.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
export async function setSetting(key, value, client = pool) {
  await client.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)],
  );
}
