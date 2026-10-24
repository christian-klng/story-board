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
`;

export const DEFAULT_BRANDING = { appName: 'Story Board', color: '#4f46e5', logo: '' };

export async function migrate() {
  // Advisory Lock, damit parallele Container (Rolling Deploy) nicht gleichzeitig migrieren
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(424242)');
    await c.query(SCHEMA);
    const { rowCount } = await c.query('SELECT 1 FROM board_columns LIMIT 1');
    if (!rowCount) await seed(c);
  });
}

async function seed(c) {
  const cols = ['Backlog', 'Bereit', 'In Arbeit', 'Review', 'Fertig'].map((name, i) => ({ id: randomUUID(), name, position: i }));
  for (const col of cols) await c.query('INSERT INTO board_columns (id, name, position) VALUES ($1,$2,$3)', [col.id, col.name, col.position]);
  await c.query(`INSERT INTO settings (key, value) VALUES ('branding', $1) ON CONFLICT DO NOTHING`, [DEFAULT_BRANDING]);
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
      `INSERT INTO stories (id, column_id, position, title, role, want, benefit, criteria, priority, points, epic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), colId, pos[colId], title, role, want, benefit, JSON.stringify(criteria), priority, points, epic],
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
