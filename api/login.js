// ─────────────────────────────────────────────────────────────
// /api/login — manager sign-in.
//
// Replaces the old flow where the client fetched the raw password column
// and compared it in the browser (visible in DevTools to anyone, and
// exfiltratable by anyone who could query the database directly). Now:
// the client sends {username, password}, this endpoint checks it
// server-side against a bcrypt hash, and returns a session token. The
// real password value never leaves the database.
//
// Existing plaintext rows are migrated automatically: on first successful
// login with the old plaintext password, it's re-hashed and saved.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, createSession, bcryptHash, bcryptCompare, looksHashed } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Missing credentials' });
    }

    const uname = String(username).trim().toLowerCase();
    const rows = await sql(
      'SELECT username,password,role,label FROM wf_users WHERE username=$1 AND role=$2 LIMIT 1',
      [uname, 'manager']
    );
    const user = rows[0];
    // Compare against a dummy hash even when the account doesn't exist, so a
    // wrong username can't be distinguished from a wrong password by timing.
    const stored = user?.password || '$2a$10$CwTycUXWue0Thq9StjUM0uJ8YoV5f5f5f5f5f5f5f5f5f5f5f5f5';

    let ok;
    if (looksHashed(stored)) {
      ok = await bcryptCompare(password, stored);
    } else {
      ok = !!user && password === stored;
      if (ok) {
        // Lazy-migrate this account from plaintext to a proper hash.
        const hash = await bcryptHash(password);
        await sql('UPDATE wf_users SET password=$1 WHERE username=$2', [hash, user.username]);
      }
    }

    if (!user || !ok) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }

    const { token } = await createSession(user.username, 'manager');
    return res.status(200).json({
      ok: true,
      token,
      user: { username: user.username, role: 'manager', label: user.label }
    });
  } catch (e) {
    console.error('login failed', e);
    return res.status(500).json({ ok: false, error: 'Login failed' });
  }
}
