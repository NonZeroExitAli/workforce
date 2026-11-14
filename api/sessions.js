// ─────────────────────────────────────────────────────────────
// /api/sessions — lets a signed-in manager see and revoke their own
// active sessions (e.g. "logged in on 3 devices, one I don't recognize").
//
//   GET     → list of the caller's own active (non-expired) sessions.
//   DELETE  → revoke one of the caller's own sessions by token. A manager
//             can only ever revoke their own sessions, never another
//             manager's — verified server-side, not just hidden in the UI.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, verifySession, forgetSession, audit } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

  const session = await verifySession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Not signed in' });

  try {
    if (req.method === 'GET') {
      const rows = await sql(
        'SELECT token,created_at,expires_at FROM wf_sessions WHERE username=$1 AND expires_at>$2 ORDER BY created_at DESC',
        [session.username, Date.now()]
      );
      // Never send full tokens to the client — only enough to identify
      // "this session" (the current one) and a short fingerprint for others.
      const out = rows.map(r => ({
        id: r.token.slice(0, 12),
        isCurrent: r.token === (req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''),
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
      }));
      return res.status(200).json({ ok: true, sessions: out });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'Missing session id' });
      // id is the 12-char token prefix we handed out above — match it back
      // to a real token, scoped to this manager's own sessions only.
      const rows = await sql('SELECT token FROM wf_sessions WHERE username=$1 AND token LIKE $2', [session.username, id + '%']);
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'Session not found' });
      forgetSession(rows[0].token);
      await sql('DELETE FROM wf_sessions WHERE token=$1', [rows[0].token]);
      await audit(session.username, 'session_revoked', session.username, { id });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('sessions op failed', e);
    return res.status(500).json({ ok: false, error: 'Session operation failed' });
  }
}
