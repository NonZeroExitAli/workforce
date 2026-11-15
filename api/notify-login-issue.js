// ─────────────────────────────────────────────────────────────
// /api/notify-login-issue — pushes an alert to every manager the moment a
// worker hits a real blocker trying to sign in (GPS denied/too far, a
// device that isn't the one on file, no assignment, a closed site...).
//
// This is intentionally a PUSH-ONLY alert: it does NOT write anything to
// a table the in-app Notifications tab reads from. It exists purely to
// tell a manager, in real time, "so-and-so is stuck outside trying to
// clock in and here's why" — something that's only useful in the moment,
// not as a persistent list to manage later.
//
// Needs the worker's session from /api/login: the problems reported here
// (GPS, site too far or closed, no assignment) all come after sign-in.
// A different device is reported by /api/login itself.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, rateLimit, sendPushToUser, verifySession } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  // Only guards against a literal double-fire (e.g. a GPS error callback
  // firing twice for one attempt, or a double click) — a few seconds is
  // plenty for that. It must NOT be long enough to swallow a worker's next
  // real retry: on a job site, "try again" often happens within seconds,
  // especially across different devices, and every one of those attempts
  // is real information the manager needs. Keyed by phone+issue only, NOT
  // by IP: multiple devices on the same job-site network share one public
  // IP, so keying on IP was silently swallowing every attempt after the
  // first "different device" try — exactly the case a manager most needs
  // to hear about.
  // Only a signed-in worker can raise an alert, and the name and phone come
  // from their record, so nobody can push made-up messages to the managers.
  // Problems before sign-in (unknown phone, other device) are handled by
  // /api/login itself.
  const session = await verifySession(req);
  if (!session || session.role !== 'worker') return res.status(401).json({ ok: false, error: 'Not signed in' });
  const { issue, urgent } = req.body || {};
  if (!issue) return res.status(400).json({ ok: false, error: 'Missing issue' });
  const [me] = await sql('SELECT label,phone FROM wf_users WHERE username=$1 LIMIT 1', [session.username]);
  const safeName = String(me?.label || session.username).slice(0, 80);
  const safePhone = String(me?.phone || '—').slice(0, 30);
  const safeIssue = String(issue).slice(0, 300);

  if (!rateLimit(`login-issue:${safePhone}:${safeIssue}`, 1, 5 * 1000)) {
    return res.status(200).json({ ok: true, throttled: true });
  }

  try {
    const managers = await sql("SELECT username FROM wf_users WHERE role='manager'");
    const body = `${safeName} (${safePhone}) — ${safeIssue}`;
    const results = await Promise.all(managers.map(m => sendPushToUser(m.username, {
      // Urgent alerts (a GPS-bypass shift with no site) stay on screen until
      // the manager taps them; see sw.js.
      title: urgent ? '⚠️ URGENTE — Turno senza GPS / عاجل' : 'Newidra — Problema di accesso / مشكلة دخول',
      body,
      urgent: !!urgent,
      url: '/?source=push',
      // No shared tag here (unlike assignment/expiry pushes): a fixed tag
      // makes each new notification SILENTLY REPLACE the previous one
      // with the same tag in the phone's notification tray instead of
      // stacking. Since a manager may need to see several distinct login
      // problems for the same worker in a row, each alert gets its own
      // tag so they all stay visible.
      tag: `login-issue-${Date.now()}`,
    })));
    const sent = results.reduce((a, r) => a + (r.sent || 0), 0);
    return res.status(200).json({ ok: true, sent, managers: managers.length });
  } catch (e) {
    console.error('notify-login-issue failed', e);
    return res.status(500).json({ ok: false, error: 'Could not send notification' });
  }
}
