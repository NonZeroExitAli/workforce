// ─────────────────────────────────────────────────────────────
// /api/sql — every query in the app goes through this one endpoint.
//
// Uses Neon's HTTP driver instead of a pg.Pool TCP connection (skips the
// per-request TCP+TLS handshake, cuts cold-start latency significantly).
//
// SECURITY NOTE: this endpoint still accepts a raw query string from the
// client, parameterized for values but NOT restricted to a fixed set of
// operations, and workers (who have no server-side session at all — see
// the login flow) have no way to prove identity on THIS endpoint, so it
// can't require a session on every call without breaking worker clock-in.
// That's a real architectural limitation, tracked for a future rewrite
// (moving to named, server-owned actions with per-action role and identity
// checks). Until then, this file does the strongest things it safely can
// WITHOUT touching how any legitimate call already behaves:
//   1. Blocks the two most damaging classes of query outright: anything
//      that could return the `password` column or a bare `SELECT *` from
//      wf_users, and DROP / TRUNCATE.
//   2. Blocks blanket UPDATE with no WHERE clause — every real UPDATE in
//      the app already targets one row via a WHERE, so this can't affect
//      legitimate traffic, but it closes off "overwrite an entire table
//      in one shot" as an attack. (DELETE is deliberately NOT included
//      here — Settings has a real, intentional "delete all shifts"
//      feature that issues a bare DELETE with no WHERE by design.)
//   3. If a request DOES carry an Authorization header (every manager
//      screen always sends one), it must now be a real, unexpired
//      session — previously this endpoint received that header on every
//      manager request and silently ignored it, so a forged or expired
//      token worked exactly as well as a real one. Real managers are
//      unaffected since they always have a valid session while logged in;
//      workers never send this header at all, so this has zero effect on
//      worker clock-in.
// This does not (yet) stop a request that omits the header entirely and
// mimics a worker call — closing that gap for real needs the named-action
// rewrite mentioned above, since the server currently has no way to
// verify "this write really belongs to this worker's own device" on a
// raw SQL string.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, rateLimit, clientIp, verifySession } from './_lib.js';

function isBlockedQuery(query) {
  const q = String(query || '');
  if (/\b(drop|truncate)\b/i.test(q)) return true;
  if (/^\s*select\b/i.test(q)) {
    if (/\bpassword\b/i.test(q)) return true;
    if (/select\s+\*\s+from\s+wf_users\b/i.test(q)) return true;
  }
  // Blanket UPDATE with no WHERE clause at all — every legitimate UPDATE
  // in this app targets a single row (WHERE id=$1 / WHERE username=$1,
  // etc.), so one missing WHERE entirely can only be a mistake or an
  // attack, never real app traffic.
  if (/^\s*update\b/i.test(q) && !/\bwhere\b/i.test(q)) return true;
  return false;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).send('POST only');

  // Generous per-IP ceiling — normal usage (dashboards firing several
  // parallel queries per screen) stays well under this. It exists to
  // blunt a scripted flood, not to throttle real users.
  if (!rateLimit(`sql:${clientIp(req)}`, 240, 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests, please slow down.' });
  }

  // If an Authorization header is present at all, it must be valid — see
  // note #3 above. A request with NO header (the normal worker case) skips
  // this check entirely and is unaffected.
  if (req.headers['authorization']) {
    const session = await verifySession(req);
    if (!session) {
      return res.status(401).json({ ok: false, error: 'Session expired or invalid, please sign in again.' });
    }
  }

  try {
    const { query, params } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Missing query' });

    if (isBlockedQuery(query)) {
      return res.status(403).json({ ok: false, error: 'This query is not permitted through this endpoint.' });
    }

    const rows = await sql(query, Array.isArray(params) ? params : []);
    return res.status(200).json({ ok: true, rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
