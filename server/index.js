import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, tx, migrate, createApp, nextNumber, DEFAULT_COLOR } from './db.js';
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
const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- Validierung ----------
const cleanColor = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toLowerCase() : DEFAULT_COLOR);
const cleanLogo = (v) => (typeof v === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(v) && v.length < 1_000_000 ? v : '');
function cleanPrefix(v) {
  const p = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(p)) throw fail(400, 'Kürzel: 2–8 Zeichen, nur A–Z und 0–9, beginnend mit einem Buchstaben');
  return p;
}
async function assertPrefixFree(c, prefix, exceptId = null) {
  const { rowCount } = await c.query('SELECT 1 FROM apps WHERE upper(prefix) = $1 AND id IS DISTINCT FROM $2', [prefix, exceptId]);
  if (rowCount) throw fail(409, `Das Kürzel ${prefix} wird schon von einer anderen App verwendet`);
}

const appSelect = `SELECT a.id, a.name, a.prefix, a.color, a.logo,
  (SELECT count(*)::int FROM stories s WHERE s.app_id = a.id) AS "storyCount" FROM apps a`;

async function findApp(c, key) {
  // Schlüssel: App-ID oder Kürzel (für ?app=shop)
  if (!key) return null;
  const { rows } = await c.query(`${appSelect} WHERE a.id = $1 OR upper(a.prefix) = upper($1) LIMIT 1`, [String(key)]);
  return rows[0] || null;
}
async function firstApp(c) {
  const { rows } = await c.query(`${appSelect} ORDER BY a.position, a.created_at LIMIT 1`);
  return rows[0] || null;
}
const branding = (a) => (a ? { appName: a.name, prefix: a.prefix, color: a.color, logo: a.logo } : null);

// ---------- Health ----------
app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ---------- Auth ----------
// Branding der zuletzt genutzten (bzw. angefragten) App ist auch ohne Login sichtbar,
// damit der Sperrbildschirm passt. Die Liste der anderen Apps gibt es erst nach dem Login.
app.get('/api/session', wrap(async (req, res) => {
  const a = (await findApp(pool, req.query.app)) || (await firstApp(pool));
  res.json({ authed: isAuthed(req), configured: passwordConfigured(), branding: branding(a) });
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

app.put('/api/password', wrap(async (req, res) => {
  const pw = String(req.body?.password ?? '');
  if (pw.length < 4) return res.status(400).json({ error: 'Mindestens 4 Zeichen' });
  await changePassword(pw);
  issueCookie(res, req); // aktuelles Gerät bleibt angemeldet, andere werden abgemeldet
  res.json({ ok: true });
}));

// ---------- Apps ----------
app.get('/api/apps', wrap(async (req, res) => {
  const { rows } = await pool.query(`${appSelect} ORDER BY a.position, a.created_at`);
  res.json(rows);
}));

app.post('/api/apps', wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 40);
  if (!name) throw fail(400, 'Name fehlt');
  const prefix = cleanPrefix(b.prefix);
  const created = await tx(async (c) => {
    await c.query('LOCK TABLE apps IN SHARE ROW EXCLUSIVE MODE');
    await assertPrefixFree(c, prefix);
    const id = await createApp(c, { name, prefix, color: cleanColor(b.color), logo: cleanLogo(b.logo) });
    return findApp(c, id);
  });
  res.status(201).json(created);
}));

// Alle App-Routen laden die App vorab; unbekannte App → 404
app.param('appId', (req, res, next, id) => {
  pool.query('SELECT id, name, prefix, color, logo FROM apps WHERE id = $1', [id])
    .then(({ rows }) => {
      if (!rows[0]) throw fail(404, 'App nicht gefunden');
      req.appRow = rows[0];
      next();
    })
    .catch(next);
});

app.patch('/api/apps/:appId', wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 40) || req.appRow.name;
  const prefix = b.prefix === undefined ? req.appRow.prefix : cleanPrefix(b.prefix);
  const updated = await tx(async (c) => {
    await c.query('LOCK TABLE apps IN SHARE ROW EXCLUSIVE MODE');
    await assertPrefixFree(c, prefix, req.appRow.id);
    await c.query('UPDATE apps SET name = $2, prefix = $3, color = $4, logo = $5 WHERE id = $1', [
      req.appRow.id, name, prefix,
      b.color === undefined ? req.appRow.color : cleanColor(b.color),
      b.logo === undefined ? req.appRow.logo : cleanLogo(b.logo),
    ]);
    return findApp(c, req.appRow.id);
  });
  res.json(updated);
}));

app.delete('/api/apps/:appId', wrap(async (req, res) => {
  await tx(async (c) => {
    await c.query('LOCK TABLE apps IN SHARE ROW EXCLUSIVE MODE');
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM apps');
    if (n <= 1) throw fail(400, 'Die letzte App kann nicht gelöscht werden');
    await c.query('DELETE FROM stories WHERE app_id = $1', [req.appRow.id]);
    await c.query('DELETE FROM board_columns WHERE app_id = $1', [req.appRow.id]);
    await c.query('DELETE FROM apps WHERE id = $1', [req.appRow.id]);
  });
  res.json({ ok: true });
}));

// ---------- Board ----------
const storySelect = `SELECT id, number, column_id AS "column", position, title, role, want, benefit, criteria, priority, points, epic,
  extract(epoch FROM created_at) * 1000 AS created FROM stories`;
const mapStory = (s) => s && { ...s, created: Number(s.created), points: s.points ?? '' };

async function loadBoard(appId, client = pool) {
  const [a, cols, stories] = await Promise.all([
    findApp(client, appId),
    client.query('SELECT id, name FROM board_columns WHERE app_id = $1 ORDER BY position', [appId]),
    client.query(`${storySelect} WHERE app_id = $1 ORDER BY column_id, position`, [appId]),
  ]);
  return {
    app: a,
    settings: branding(a),
    columns: cols.rows,
    stories: stories.rows.map(mapStory),
  };
}

app.get('/api/apps/:appId/board', wrap(async (req, res) => res.json(await loadBoard(req.appRow.id))));

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
  if (!out.title) throw fail(400, 'Titel fehlt');
  return out;
}

async function getStory(id, client = pool) {
  const { rows } = await client.query(`${storySelect} WHERE id = $1`, [id]);
  return mapStory(rows[0]);
}

async function columnApp(c, columnId) {
  const { rows } = await c.query('SELECT app_id FROM board_columns WHERE id = $1', [String(columnId ?? '')]);
  if (!rows[0]) throw fail(400, 'Spalte existiert nicht');
  return rows[0].app_id;
}

// Die App ergibt sich aus der Spalte
app.post('/api/stories', wrap(async (req, res) => {
  const s = cleanStory(req.body);
  const story = await tx(async (c) => {
    const appId = await columnApp(c, req.body.column);
    const id = randomUUID();
    await c.query(
      `INSERT INTO stories (id, app_id, column_id, position, number, title, role, want, benefit, criteria, priority, points, epic)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position) + 1, 0) FROM stories WHERE column_id = $3), $4, $5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, appId, req.body.column, await nextNumber(c, appId), s.title, s.role, s.want, s.benefit, JSON.stringify(s.criteria), s.priority, s.points, s.epic],
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
  if (!rowCount) throw fail(404, 'Story nicht gefunden');
  res.json(await getStory(req.params.id));
}));

app.delete('/api/stories/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM stories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Verschieben: in Spalte `column`, vor Story `before` (oder ans Ende) – nur innerhalb derselben App
app.post('/api/stories/:id/move', wrap(async (req, res) => {
  const { column, before = null } = req.body || {};
  await tx(async (c) => {
    const { rows: [story] } = await c.query('SELECT app_id FROM stories WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!story) throw fail(404, 'Story nicht gefunden');
    if ((await columnApp(c, column)) !== story.app_id) throw fail(400, 'Spalte gehört zu einer anderen App');
    const { rows } = await c.query('SELECT id FROM stories WHERE column_id = $1 AND id <> $2 ORDER BY position FOR UPDATE', [column, req.params.id]);
    const ids = rows.map((r) => r.id);
    const at = before ? ids.indexOf(before) : -1;
    ids.splice(at < 0 ? ids.length : at, 0, req.params.id);
    await c.query('UPDATE stories SET column_id = $2, updated_at = now() WHERE id = $1', [req.params.id, column]);
    await c.query(
      'UPDATE stories s SET position = v.pos - 1 FROM unnest($1::text[]) WITH ORDINALITY AS v(id, pos) WHERE s.id = v.id',
      [ids],
    );
  });
  res.json({ ok: true });
}));

// ---------- Spalten ----------
// [{id?, name}] in gewünschter Reihenfolge. Fehlende werden gelöscht, deren Stories wandern in die erste Spalte.
app.put('/api/apps/:appId/columns', wrap(async (req, res) => {
  const appId = req.appRow.id;
  const list = (Array.isArray(req.body) ? req.body : [])
    .map((c) => ({ id: c.id ? String(c.id) : null, name: str(c.name, 40) }))
    .filter((c) => c.name).slice(0, 20);
  if (!list.length) throw fail(400, 'Mindestens eine Spalte nötig');
  await tx(async (c) => {
    const { rows } = await c.query('SELECT id FROM board_columns WHERE app_id = $1', [appId]);
    const existing = new Set(rows.map((r) => r.id));
    list.forEach((col) => { if (!col.id || !existing.has(col.id)) col.id = randomUUID(); });
    for (const [i, col] of list.entries()) {
      await c.query(
        `INSERT INTO board_columns (id, app_id, name, position) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position`,
        [col.id, appId, col.name, i],
      );
    }
    const keep = list.map((col) => col.id);
    const first = keep[0];
    await c.query(
      `UPDATE stories SET column_id = $1, position = position + 100000 WHERE app_id = $2 AND NOT (column_id = ANY($3::text[]))`,
      [first, appId, keep],
    );
    await c.query('DELETE FROM board_columns WHERE app_id = $1 AND NOT (id = ANY($2::text[]))', [appId, keep]);
    await c.query(
      `UPDATE stories s SET position = r.rn FROM
        (SELECT id, row_number() OVER (ORDER BY position) - 1 AS rn FROM stories WHERE column_id = $1) r
       WHERE s.id = r.id`,
      [first],
    );
  });
  res.json(await loadBoard(appId));
}));

// ---------- Export / Import (pro App) ----------
app.get('/api/apps/:appId/export', wrap(async (req, res) => {
  const data = await loadBoard(req.appRow.id);
  const name = req.appRow.prefix.toLowerCase();
  res.set('Content-Disposition', `attachment; filename="storyboard-${name}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ version: 3, ...data });
}));

// Ersetzt Inhalt und Branding der App. Das Kürzel bleibt; Story-Nummern aus dem Backup bleiben erhalten.
// Versteht auch Backups aus der Zeit vor den Apps (version 2).
app.post('/api/apps/:appId/import', express.json({ limit: '10mb' }), wrap(async (req, res) => {
  const appId = req.appRow.id;
  const { columns, stories, settings, app: srcApp } = req.body || {};
  if (!Array.isArray(columns) || !columns.length || !Array.isArray(stories)) throw fail(400, 'Ungültige Datei');
  await tx(async (c) => {
    await c.query('SELECT 1 FROM apps WHERE id = $1 FOR UPDATE', [appId]);
    await c.query('DELETE FROM stories WHERE app_id = $1', [appId]);
    await c.query('DELETE FROM board_columns WHERE app_id = $1', [appId]);
    const idMap = new Map();
    for (const [i, col] of columns.entries()) {
      const id = randomUUID();
      idMap.set(String(col.id), id);
      await c.query('INSERT INTO board_columns (id, app_id, name, position) VALUES ($1,$2,$3,$4)', [id, appId, str(col.name, 40) || `Spalte ${i + 1}`, i]);
    }
    const firstCol = idMap.values().next().value;
    const valid = (n) => Number.isInteger(n) && n > 0 && n <= 2_000_000_000;
    const used = new Set();
    let next = Math.max(0, ...stories.map((r) => Number(r?.number)).filter(valid)) + 1;
    const pos = {};
    for (const raw of stories) {
      let s;
      try { s = cleanStory(raw); } catch { continue; }
      let number = Number(raw.number);
      if (!valid(number) || used.has(number)) number = next++;
      used.add(number);
      const colId = idMap.get(String(raw.column)) || firstCol;
      pos[colId] = (pos[colId] ?? -1) + 1;
      const created = Number(raw.created) > 0 ? new Date(Number(raw.created)) : new Date();
      await c.query(
        `INSERT INTO stories (id, app_id, column_id, position, number, title, role, want, benefit, criteria, priority, points, epic, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [randomUUID(), appId, colId, pos[colId], number, s.title, s.role, s.want, s.benefit, JSON.stringify(s.criteria), s.priority, s.points, s.epic, created],
      );
    }
    const src = srcApp || (settings ? { name: settings.appName, color: settings.color, logo: settings.logo } : null);
    await c.query(
      `UPDATE apps SET next_number = GREATEST($2, (SELECT COALESCE(MAX(number), 0) + 1 FROM stories WHERE app_id = $1)),
         name = COALESCE($3, name), color = COALESCE($4, color), logo = COALESCE($5, logo) WHERE id = $1`,
      [appId, next, src ? str(src.name, 40) || null : null, src ? cleanColor(src.color) : null, src ? cleanLogo(src.logo) : null],
    );
  });
  res.json(await loadBoard(appId));
}));

// ---------- Frontend ----------
// "no-cache" = Browser darf speichern, fragt aber bei jedem Laden per ETag nach (meist 304, kaum Traffic).
// So passen HTML, CSS und JS nach einem Deploy immer zusammen.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Konflikt mit bestehenden Daten, bitte neu laden' });
  console.error(err);
  res.status(500).json({ error: 'Serverfehler' });
});

// ---------- Start ----------
async function start() {
  for (let i = 1; ; i++) { // DB ist beim Deploy evtl. noch nicht bereit
    try { await migrate(); break; } catch (e) {
      if (i >= 15 || !['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', '57P03'].includes(e.code)) throw e;
      console.log(`Datenbank nicht erreichbar (${e.code}), neuer Versuch in 2 s …`);
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
