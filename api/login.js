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
import { sql, setCors, createSession, bcryptHash, bcryptCompare, looksHashed, rateLimit, clientIp, audit } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const ip = clientIp(req);
  // 8 attempts / 5 minutes per IP, and per attempted username — blocks both
  // a single attacker hammering one account and one hammering many accounts.
  if (!rateLimit(`login:ip:${ip}`, 8, 5 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Missing credentials' });
    }

    const uname = String(username).trim().toLowerCase();
    if (!rateLimit(`login:user:${uname}`, 8, 5 * 60 * 1000)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
    }

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
      await audit(uname, 'login_failed', uname, { ip });
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }

    const { token } = await createSession(user.username, 'manager');
    await audit(user.username, 'login_success', user.username, { ip });
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
