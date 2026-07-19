
import { sql, setCors, rateLimit, clientIp, verifySession } from './_lib.js';

function isBlockedQuery(query) {
  const q = String(query || '');
  if (/\b(drop|truncate)\b/i.test(q)) return true;
  if (/^\s*select\b/i.test(q)) {
    if (/\bpassword\b/i.test(q)) return true;
    if (/select\s+\*\s+from\s+wf_users\b/i.test(q)) return true;
  }

  if (/^\s*update\b/i.test(q) && !/\bwhere\b/i.test(q)) return true;
  return false;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).send('POST only');


  if (!rateLimit(`sql:${clientIp(req)}`, 240, 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests, please slow down.' });
  }


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
