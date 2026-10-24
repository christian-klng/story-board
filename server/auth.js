import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getSetting, setSetting } from './db.js';

const scrypt = promisify(_scrypt);
const COOKIE = 'sb_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 Tage

let secret;
let pwFingerprint = ''; // ändert sich mit dem Passwort → alte Sessions werden ungültig

async function hashPw(pw, salt = randomBytes(16).toString('hex')) {
  const key = await scrypt(pw, salt, 64);
  return { salt, hash: key.toString('hex') };
}

export async function initAuth() {
  secret = process.env.SESSION_SECRET || (await getSetting('session_secret'));
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    await setSetting('session_secret', secret);
  }
  await refreshFingerprint();
  if (!pwFingerprint) console.warn('⚠ Kein Passwort gesetzt. Bitte APP_PASSWORD als Umgebungsvariable setzen.');
}

async function refreshFingerprint() {
  const stored = await getSetting('password');
  const base = stored ? stored.hash : process.env.APP_PASSWORD ? 'env:' + process.env.APP_PASSWORD : '';
  pwFingerprint = base ? createHmac('sha256', 'fp').update(base).digest('hex').slice(0, 16) : '';
}

export const passwordConfigured = () => Boolean(pwFingerprint);

export async function checkPassword(pw) {
  const stored = await getSetting('password');
  if (stored) {
    const { hash } = await hashPw(pw, stored.salt);
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored.hash, 'hex'));
  }
  const envPw = process.env.APP_PASSWORD;
  if (!envPw) return false;
  const a = createHmac('sha256', secret).update(pw).digest();
  const b = createHmac('sha256', secret).update(envPw).digest();
  return timingSafeEqual(a, b);
}

export async function changePassword(pw) {
  await setSetting('password', await hashPw(pw));
  await refreshFingerprint();
}

function sign(payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueCookie(res, req) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = `${exp}.${pwFingerprint}`;
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', secure, maxAge: MAX_AGE * 1000, path: '/',
  });
}

export function clearCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function isAuthed(req) {
  const token = readCookie(req);
  if (!token || !pwFingerprint) return false;
  const [exp, fp, sig] = token.split('.');
  if (!exp || !sig) return false;
  const expected = sign(`${exp}.${fp}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return fp === pwFingerprint && Number(exp) > Date.now() / 1000;
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Nicht angemeldet' });
}

// Einfacher Schutz gegen Durchprobieren: 10 Fehlversuche pro IP in 15 Minuten
const attempts = new Map();
export function loginLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  if (list.length >= 10) return res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut probieren.' });
  req.registerFailedLogin = () => list.push(now);
  next();
}
