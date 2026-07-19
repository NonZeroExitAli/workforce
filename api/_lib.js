// ─────────────────────────────────────────────────────────────
// /api/_lib.js — shared helpers for the API routes.
//
// A file starting with "_" is NOT treated as a route by Vercel, so this
// can be imported by the other /api files without becoming its own
// public endpoint.
// ─────────────────────────────────────────────────────────────
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export const sql = neon(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);

// Locks CORS down to the real app origin instead of "*". Set APP_ORIGIN in
// Vercel's environment variables if you ever move to a custom domain.
export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_ORIGIN || 'https://workforce-omega.vercel.app');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST,DELETE,GET,OPTIONS');
}

export async function createSession(username, role, days = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires = now + days * 24 * 60 * 60 * 1000;
  await sql(
    'INSERT INTO wf_sessions(token,username,role,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
    [token, username, role, now, expires]
  );
  return { token, expires };
}

// Reads "Authorization: Bearer <token>" and returns the session row, or null.
export async function verifySession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  const rows = await sql('SELECT token,username,role,expires_at FROM wf_sessions WHERE token=$1 LIMIT 1', [token]);
  const s = rows[0];
  if (!s) return null;
  if (Number(s.expires_at) < Date.now()) return null;
  return s;
}

export const bcryptHash = (pw) => bcrypt.hash(pw, 10);
export const bcryptCompare = (pw, hash) => bcrypt.compare(pw, hash);
export const looksHashed = (pw) => typeof pw === 'string' && /^\$2[aby]\$/.test(pw);

// ── Rate limiting ───────────────────────────────────────────────
// In-memory sliding window, keyed per warm serverless instance. This is a
// best-effort defense, not a perfect one: a cold start or a request landing
// on a different instance resets the count for that instance. It still
// meaningfully raises the bar against a single script hammering one
// endpoint (the common case), which is what this is for. A fully accurate
// limit across all instances would need an external store (e.g. Upstash
// Redis) — flagged as a possible future upgrade, out of scope for now.
const _rlBuckets = new Map(); // key -> array of request timestamps (ms)

export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let arr = _rlBuckets.get(key);
  if (!arr) {
    arr = [];
    _rlBuckets.set(key, arr);
  }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  // Cheap guard against unbounded memory growth if this instance stays warm
  // a long time and sees traffic from many distinct keys/IPs.
  if (_rlBuckets.size > 5000) _rlBuckets.clear();
  return true;
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ── Audit log ────────────────────────────────────────────────────
// Best-effort security/activity trail. Logging failures never break the
// calling action — an audit entry is a nice-to-have, not something that
// should ever cause a 500 on a real user action.
export async function audit(actorUsername, action, target, details) {
  try {
    await sql(
      'INSERT INTO wf_audit_log(actor_username,action,target,details,created_at) VALUES($1,$2,$3,$4,$5)',
      [actorUsername || null, action, target || null, details ? JSON.stringify(details) : null, Date.now()]
    );
  } catch (e) {
    console.error('audit log failed', e);
  }
}
