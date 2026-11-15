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
import { sql, setCors, createSession, bcryptHash, bcryptCompare, looksHashed, rateLimit, clientIp, audit, sendPushToUser } from './_lib.js';
import { USER_COLS, normPhone } from './_worker.js';

// Worker sign-in: {phone, deviceId}. The phone must be on the manager's list,
// the worker not archived, and the device the one registered on first sign-in.
// Returns a worker session, which /api/sql limits to the worker's own data.
async function workerLogin(req, res, ip) {
  if (!rateLimit(`wlogin:ip:${ip}`, 20, 5 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'too_many' });
  }
  const { phone, deviceId } = req.body || {};
  const norm = normPhone(phone);
  if (!norm || typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 80) {
    return res.status(400).json({ ok: false, error: 'bad_phone' });
  }
  const [match] = await sql('SELECT norm,phone,label,rate FROM wf_phones WHERE norm=$1 LIMIT 1', [norm]);
  if (!match) return res.status(403).json({ ok: false, error: 'not_authorized' });

  const find = () => sql(`SELECT ${USER_COLS} FROM wf_users WHERE role='worker' AND ltrim(regexp_replace(COALESCE(phone,''),'\\D','','g'),'0')=$1 ORDER BY COALESCE(archived,false) ASC LIMIT 1`, [norm]);
  let [user] = await find();
  if (user && user.archived) return res.status(403).json({ ok: false, error: 'archived' });

  if (!user) {
    // First sign-in: the account is made from the phone list entry.
    const base = String(match.label || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'w' + norm.slice(-6);
    const [taken] = await sql('SELECT 1 FROM wf_users WHERE username=$1 LIMIT 1', [base]);
    const uname = taken ? base + '_' + norm.slice(-4) : base;
    await sql("INSERT INTO wf_users(username,role,phone,hourly_rate,device_id,can_restart) VALUES($1,'worker',$2,$3,$4,false) ON CONFLICT(username) DO NOTHING",
      [uname, String(phone).trim(), Number(match.rate) || 15, deviceId]);
    await sql('UPDATE wf_phones SET used=true WHERE norm=$1', [norm]);
    [user] = await find();
    if (!user) return res.status(500).json({ ok: false, error: 'create_failed' });
  }

  if (!user.device_id) {
    await sql('UPDATE wf_users SET device_id=$1 WHERE username=$2', [deviceId, user.username]);
    user.device_id = deviceId;
  } else if (user.device_id !== deviceId) {
    const managers = await sql("SELECT username FROM wf_users WHERE role='manager'");
    await Promise.all(managers.map(m => sendPushToUser(m.username, {
      title: 'Newidra — Problema di accesso / مشكلة دخول',
      body: `${user.label || user.username} (${user.phone || '—'}) — Ha provato ad accedere da un telefono diverso da quello registrato / حاول الدخول من جهاز مختلف عن الجهاز المسجل`,
      url: '/?source=push',
      tag: `login-issue-${Date.now()}`,
    })));
    return res.status(403).json({ ok: false, error: 'device' });
  }

  // One live session per worker: signing in again replaces the old one.
  await sql("DELETE FROM wf_sessions WHERE username=$1 AND role='worker'", [user.username]);
  const { token } = await createSession(user.username, 'worker', 7);
  return res.status(200).json({ ok: true, token, user });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const ip = clientIp(req);
  if (req.body && req.body.phone !== undefined) {
    try {
      return await workerLogin(req, res, ip);
    } catch (e) {
      console.error('worker login failed', e);
      return res.status(500).json({ ok: false, error: 'login_failed' });
    }
  }
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
