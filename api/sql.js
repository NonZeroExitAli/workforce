
import { sql, setCors, rateLimit, clientIp, verifySession } from './_lib.js';
import { runWorkerQuery } from './_worker.js';

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


  // A loose per-IP cap first, so made-up tokens can't flood the session lookup.
  if (!rateLimit(`sql-ip:${clientIp(req)}`, 1200, 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests, please slow down.' });
  }

  // Every query needs a signed-in session. Managers can run any query;
  // workers only the statements in _worker.js, on their own rows.
  const session = await verifySession(req);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Session expired or invalid, please sign in again.' });
  }
  // Counted per person, not per IP: phones on one site's Wi-Fi share an IP.
  if (!rateLimit(`sql:${session.username}`, 240, 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests, please slow down.' });
  }

  try {
    const { query, params } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Missing query' });

    if (session.role === 'worker') {
      const rows = await runWorkerQuery(session.username, query, params);
      return res.status(200).json({ ok: true, rows });
    }
    if (session.role !== 'manager') return res.status(403).json({ ok: false, error: 'Not permitted' });

    if (isBlockedQuery(query)) {
      return res.status(403).json({ ok: false, error: 'This query is not permitted through this endpoint.' });
    }

    const rows = await sql(query, Array.isArray(params) ? params : []);
    return res.status(200).json({ ok: true, rows });
  } catch (err) {
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
}
