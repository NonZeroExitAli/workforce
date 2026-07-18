// ─────────────────────────────────────────────────────────────
// /api/logout — invalidates the session token server-side.
// ─────────────────────────────────────────────────────────────
import { sql, setCors } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (token) await sql('DELETE FROM wf_sessions WHERE token=$1', [token]);
  } catch (e) {
    // Logging out should never hard-fail the UI even if this errors.
    console.error('logout cleanup failed', e);
  }
  return res.status(200).json({ ok: true });
}
