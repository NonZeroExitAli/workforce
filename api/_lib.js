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
import webpush from 'web-push';

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

// ── Web Push ────────────────────────────────────────────────────
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set once in Vercel's environment
// variables. The public key is also embedded in the client so the browser
// can subscribe; the private key never leaves the server, and is what
// actually lets this server (and only this server) send pushes signed as
// this app.
let _vapidReady = false;
function _ensureVapid() {
  if (_vapidReady) return;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      'mailto:admin@newidra.app',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    _vapidReady = true;
  }
}

// Sends one push to every subscription a username has registered (they may
// have several devices). Dead/expired subscriptions (410 Gone / 404) are
// cleaned up automatically. Never throws — a failed push should never take
// down the caller.
export async function sendPushToUser(username, payload) {
  _ensureVapid();
  if (!_vapidReady) return { sent: 0, reason: 'VAPID keys not configured' };
  const subs = await sql('SELECT id,endpoint,p256dh,auth FROM wf_push_subscriptions WHERE username=$1', [username]);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        // Without an explicit urgency, the push protocol defaults to
        // "normal" — which Android/FCM is allowed to defer until the
        // device wakes up on its own (Doze mode holds "normal" pushes
        // back to save battery, only flushing them once the screen turns
        // on or the phone is unlocked). "high" tells the push service to
        // wake the device immediately instead of batching it for later —
        // this is what was causing notifications to only ever "arrive"
        // at the moment someone unlocked the phone and opened the app,
        // when in fact they'd been sent and sitting queued the whole
        // time. TTL is a 1-hour delivery window: long enough to survive
        // a brief connectivity gap, short enough that a stale alert
        // (e.g. a shift-ending reminder for a shift that already ended)
        // doesn't show up hours late.
        { urgency: 'high', TTL: 3600 }
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await sql('DELETE FROM wf_push_subscriptions WHERE id=$1', [s.id]).catch(() => {});
      } else {
        console.error('push send failed for', username, e.statusCode, e.message);
      }
    }
  }));
  return { sent, total: subs.length };
}
