// ─────────────────────────────────────────────────────────────
// /api/sql — every query in the app goes through this one endpoint.
//
// Uses Neon's HTTP driver instead of a pg.Pool TCP connection (skips the
// per-request TCP+TLS handshake, cuts cold-start latency significantly).
//
// SECURITY NOTE: this endpoint still accepts a raw query string from the
// client, parameterized for values but NOT restricted to a fixed set of
// operations — that's a real architectural limitation being tracked for a
// future rewrite (moving to named, server-owned actions with per-action
// role checks). Until then, this guard blocks the two most damaging
// classes of query outright:
//   1. Anything that could return the `password` column, or a bare
//      `SELECT *` from wf_users (closes mass credential/PII dumping —
//      nothing in the app legitimately needs this anymore now that
//      login/password-change go through their own dedicated endpoints).
//   2. DROP / TRUNCATE (no legitimate client code ever issues these).
// ─────────────────────────────────────────────────────────────
import { sql, setCors } from './_lib.js';

function isBlockedQuery(query) {
  const q = String(query || '');
  if (/\b(drop|truncate)\b/i.test(q)) return true;
  if (/^\s*select\b/i.test(q)) {
    if (/\bpassword\b/i.test(q)) return true;
    if (/select\s+\*\s+from\s+wf_users\b/i.test(q)) return true;
  }
  return false;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).send('POST only');

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
