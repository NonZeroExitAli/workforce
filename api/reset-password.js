// ─────────────────────────────────────────────────────────────
// /api/reset-password — generates a fresh one-time password for the
// SIGNED-IN manager's own account and returns it once so it can be
// copied down. Replaces the old "reset to a hardcoded default password"
// flow, which shipped a public, unchangeable password in the client code.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, verifySession, bcryptHash, rateLimit, clientIp, audit } from './_lib.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const session = await verifySession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Not signed in' });

  if (!rateLimit(`reset-pwd:${session.username}:${clientIp(req)}`, 6, 5 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  try {
    const tempPassword = crypto.randomBytes(6).toString('base64url'); // ~8 random chars
    const hash = await bcryptHash(tempPassword);
    await sql('UPDATE wf_users SET password=$1 WHERE username=$2', [hash, session.username]);
    await audit(session.username, 'password_reset', session.username, {});
    return res.status(200).json({ ok: true, tempPassword });
  } catch (e) {
    console.error('reset-password failed', e);
    return res.status(500).json({ ok: false, error: 'Could not reset password' });
  }
}
