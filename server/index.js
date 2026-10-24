import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, tx, migrate, getSetting, setSetting, DEFAULT_BRANDING } from './db.js';
import {
  initAuth, checkPassword, changePassword, issueCookie, clearCookie,
  isAuthed, requireAuth, loginLimiter, passwordConfigured,
} from './auth.js';

const PORT = Number(process.env.PORT) || 3000;
const PRIORITIES = ['must', 'should', 'could', 'wont'];
const POINTS = [1, 2, 3, 5, 8, 13, 21];
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', true); // Coolify/Traefik setzt X-Forwarded-*
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

// ---------- Health ----------
app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ---------- Auth ----------
app.get('/api/session', wrap(async (req, res) => {
  // Branding ist auch ohne Login sichtbar, damit der Sperrbildschirm passend aussieht
  const branding = { ...DEFAULT_BRANDING, ...(await getSetting('branding')) };
  res.json({ authed: isAuthed(req), configured: passwordConfigured(), branding });
}));

app.post('/api/login', loginLimiter, wrap(async (req, res) => {
  if (!passwordConfigured()) return res.status(503).json({ error: 'Kein Passwort konfiguriert (APP_PASSWORD fehlt).' });
  if (!(await checkPassword(String(req.body?.password ?? '')))) {
    req.registerFailedLogin();
    return res.status(401).json({ error: 'Falsches Passwort.' });
  }
  issueCookie(res, req);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { clearCookie(res); res.json({ ok: true }); });

app.use('/api', requireAuth);

// ---------- Board ----------
const storySelect = `SELECT id, column_id AS "column", position, title, role, want, benefit, criteria, priority, points, epic,
  extract(epoch FROM created_at) * 1000 AS created FROM stories`;

async function loadBoard(client = pool) {
  const [cols, stories, branding] = await Promise.all([
    client.query('SELECT id, name FROM board_columns ORDER BY position'),
    client.query(`${storySelect} ORDER BY column_id, position`),
    getSetting('branding', client),
  ]);
  return {
    settings: { ...DEFAULT_BRANDING, ...branding },
    columns: cols.rows,
    stories: stories.rows.map((s) => ({ ...s, created: Number(s.created), points: s.points ?? '' })),
  };
}

app.get('/api/board', wrap(async (req, res) => res.json(await loadBoard())));

// ---------- Stories ----------
function cleanStory(b) {
  const out = {
    title: str(b.title, 120),
    role: str(b.role), want: str(b.want), benefit: str(b.benefit),
    criteria: (Array.isArray(b.criteria) ? b.criteria : []).map((c) => str(c)).filter(Boolean).slice(0, 50),
    priority: PRIORITIES.includes(b.priority) ? b.priority : 'could',
    points: POINTS.includes(Number(b.points)) ? Number(b.points) : null,
    epic: str(b.epic, 80),
  };
  if (!out.title) throw Object.assign(new Error('Titel fehlt'), { status: 400 });
  return out;
}

async function getStory(id, client = pool) {
  const { rows } = await client.query(`${storySelect} WHERE id = $1`, [id]);
  const s = rows[0];
  return s && { ...s, created: Number(s.created), points: s.points ?? '' };
}

async function assertColumn(client, id) {
  const { rowCount } = await client.query('SELECT 1 FROM board_columns WHERE id = $1', [id]);
  if (!rowCount) throw Object.assign(new Error('Spalte existiert nicht'), { status: 400 });
}

app.post('/api/stories', wrap(async (req, res) => {
  const s = cleanStory(req.body);
  const story = await tx(async (c) => {
    await assertColumn(c, req.body.column);
    const id = randomUUID();
    await c.query(
      `INSERT INTO stories (id, column_id, position, title, role, want, benefit, criteria, priority, points, epic)
       VALUES ($1, $2, (SELECT COALESCE(MAX(position) + 1, 0) FROM stories WHERE column_id = $2), $3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, req.body.column, s.title, s.role, s.want, s.benefit, JSON.stringify(s.criteria), s.priority, s.points, s.epic],
    );
    return getStory(id, c);
  });
  res.status(201).json(story);
}));

app.patch('/api/stories/:id', wrap(async (req, res) => {
  const s = cleanStory(req.body);
  const { rowCount } = await pool.query(
    `UPDATE stories SET title=$2, role=$3, want=$4, benefit=$5, criteria=$6, priority=$7, points=$8, epic=$9, updated_at=now()
     WHERE id = $1`,
    [req.params.id, s.title, s.role, s.want, s.benefit, JSON.stringify(s.criteria), s.priority, s.points, s.epic],
  );
  if (!rowCount) return res.status(404).json({ error: 'Story nicht gefunden' });
  res.json(await getStory(req.params.id));
}));

app.delete('/api/stories/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM stories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Verschieben: in Spalte `column`, vor Story `before` (oder ans Ende)
app.post('/api/stories/:id/move', wrap(async (req, res) => {
  const { column, before = null } = req.body || {};
  await tx(async (c) => {
    await assertColumn(c, column);
    const { rows } = await c.query('SELECT id FROM stories WHERE column_id = $1 AND id <> $2 ORDER BY position FOR UPDATE', [column, req.params.id]);
    const ids = rows.map((r) => r.id);
    const at = before ? ids.indexOf(before) : -1;
    ids.splice(at < 0 ? ids.length : at, 0, req.params.id);
    const { rowCount } = await c.query('UPDATE stories SET column_id = $2, updated_at = now() WHERE id = $1', [req.params.id, column]);
    if (!rowCount) throw Object.assign(new Error('Story nicht gefunden'), { status: 404 });
    await c.query(
      'UPDATE stories s SET position = v.pos - 1 FROM unnest($1::text[]) WITH ORDINALITY AS v(id, pos) WHERE s.id = v.id',
      [ids],
    );
  });
  res.json({ ok: true });
}));

// ---------- Einstellungen ----------
app.put('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : DEFAULT_BRANDING.color;
  const logo = typeof b.logo === 'string' && (b.logo === '' || /^data:image\/(png|jpeg|webp|gif);base64,/.test(b.logo)) && b.logo.length < 1_000_000 ? b.logo : '';
  const branding = { appName: str(b.appName, 40) || DEFAULT_BRANDING.appName, color, logo };
  await setSetting('branding', branding);
  res.json(branding);
}));

// Spalten: [{id?, name}] in gewünschter Reihenfolge. Fehlende werden gelöscht, deren Stories wandern in die erste Spalte.
app.put('/api/columns', wrap(async (req, res) => {
  const list = (Array.isArray(req.body) ? req.body : [])
    .map((c) => ({ id: c.id ? String(c.id) : null, name: str(c.name, 40) }))
    .filter((c) => c.name).slice(0, 20);
  if (!list.length) return res.status(400).json({ error: 'Mindestens eine Spalte nötig' });
  await tx(async (c) => {
    const { rows } = await c.query('SELECT id FROM board_columns');
    const existing = new Set(rows.map((r) => r.id));
    list.forEach((col) => { if (!col.id || !existing.has(col.id)) col.id = randomUUID(); });
    for (const [i, col] of list.entries()) {
      await c.query(
        `INSERT INTO board_columns (id, name, position) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position`,
        [col.id, col.name, i],
      );
    }
    const keep = list.map((col) => col.id);
    const first = keep[0];
    await c.query(
      `UPDATE stories SET column_id = $1, position = position + 100000 WHERE NOT (column_id = ANY($2::text[]))`,
      [first, keep],
    );
    await c.query('DELETE FROM board_columns WHERE NOT (id = ANY($1::text[]))', [keep]);
    await c.query(
      `UPDATE stories s SET position = r.rn FROM
        (SELECT id, row_number() OVER (ORDER BY position) - 1 AS rn FROM stories WHERE column_id = $1) r
       WHERE s.id = r.id`,
      [first],
    );
  });
  res.json(await loadBoard());
}));

app.put('/api/password', wrap(async (req, res) => {
  const pw = String(req.body?.password ?? '');
  if (pw.length < 4) return res.status(400).json({ error: 'Mindestens 4 Zeichen' });
  await changePassword(pw);
  issueCookie(res, req); // aktuelles Gerät bleibt angemeldet, andere werden abgemeldet
  res.json({ ok: true });
}));

// ---------- Export / Import ----------
app.get('/api/export', wrap(async (req, res) => {
  const data = await loadBoard();
  res.set('Content-Disposition', `attachment; filename="storyboard-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ version: 2, ...data });
}));

app.post('/api/import', express.json({ limit: '10mb' }), wrap(async (req, res) => {
  const { columns, stories, settings } = req.body || {};
  if (!Array.isArray(columns) || !columns.length || !Array.isArray(stories)) {
    return res.status(400).json({ error: 'Ungültige Datei' });
  }
  await tx(async (c) => {
    await c.query('DELETE FROM stories');
    await c.query('DELETE FROM board_columns');
    const idMap = new Map();
    for (const [i, col] of columns.entries()) {
      const id = randomUUID();
      idMap.set(String(col.id), id);
      await c.query('INSERT INTO board_columns (id, name, position) VALUES ($1,$2,$3)', [id, str(col.name, 40) || `Spalte ${i + 1}`, i]);
    }
    const firstCol = idMap.values().next().value;
    const pos = {};
    for (const raw of stories) {
      let s;
      try { s = cleanStory(raw); } catch { continue; }
      const colId = idMap.get(String(raw.column)) || firstCol;
      pos[colId] = (pos[colId] ?? -1) + 1;
      const created = Number(raw.created) > 0 ? new Date(Number(raw.created)) : new Date();
      await c.query(
        `INSERT INTO stories (id, column_id, position, title, role, want, benefit, criteria, priority, points, epic, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(), colId, pos[colId], s.title, s.role, s.want, s.benefit, JSON.stringify(s.criteria), s.priority, s.points, s.epic, created],
      );
    }
    if (settings) {
      const color = /^#[0-9a-f]{6}$/i.test(settings.color) ? settings.color : DEFAULT_BRANDING.color;
      const logo = typeof settings.logo === 'string' && /^data:image\//.test(settings.logo) ? settings.logo : '';
      await setSetting('branding', { appName: str(settings.appName, 40) || DEFAULT_BRANDING.appName, color, logo }, c);
    }
  });
  res.json(await loadBoard());
}));

// ---------- Frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Serverfehler' });
});

// ---------- Start ----------
async function start() {
  for (let i = 1; ; i++) { // DB ist beim Deploy evtl. noch nicht bereit
    try { await migrate(); break; } catch (e) {
      if (i >= 15) throw e;
      console.log(`Datenbank nicht erreichbar (${e.code || e.message}), neuer Versuch in 2 s …`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await initAuth();
  const server = app.listen(PORT, () => console.log(`Story Board läuft auf Port ${PORT}`));
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch((e) => { console.error(e); process.exit(1); });
