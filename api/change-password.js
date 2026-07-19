// ─────────────────────────────────────────────────────────────
// /api/change-password — manager changes their own password.
//
// Requires a valid session token. Verifies the current password
// server-side (never trusts a client-side comparison) and stores the
// new one as a bcrypt hash.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, verifySession, bcryptHash, bcryptCompare, looksHashed, rateLimit, clientIp, audit } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const session = await verifySession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Not signed in' });

  if (!rateLimit(`change-pwd:${session.username}:${clientIp(req)}`, 6, 5 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
    }

    const rows = await sql('SELECT username,password FROM wf_users WHERE username=$1 LIMIT 1', [session.username]);
    const user = rows[0];
    if (!user) return res.status(404).json({ ok: false, error: 'Account not found' });

    const stored = user.password || '';
    const ok = looksHashed(stored)
      ? await bcryptCompare(currentPassword || '', stored)
      : currentPassword === stored;
    if (!ok) return res.status(401).json({ ok: false, error: 'Current password is wrong' });

    const hash = await bcryptHash(newPassword);
    await sql('UPDATE wf_users SET password=$1 WHERE username=$2', [hash, user.username]);
    await audit(session.username, 'password_changed', user.username, {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('change-password failed', e);
    return res.status(500).json({ ok: false, error: 'Could not change password' });
  }
}
