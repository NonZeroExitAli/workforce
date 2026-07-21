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
// No session on this one — a worker hitting a login problem has, by
// definition, no session (workers never have one) and may not even be
// past the point of being recognized as a real account yet (e.g. a
// device mismatch happens BEFORE any session-like state exists). Rate
// limiting is the guard here instead, same pattern as the other
// no-session worker-facing endpoints.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, rateLimit, sendPushToUser } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  // One alert per worker PER ISSUE TYPE within a short window — this
  // exists so a worker repeatedly retrying the exact same blocker (e.g.
  // denying the GPS prompt three times in a row) doesn't fire three
  // separate pushes to every manager. Deliberately keyed by phone+issue
  // only, NOT by IP: multiple devices on the same job-site network share
  // one public IP, so keying on IP was silently swallowing every attempt
  // after the first "different device" try — exactly the case a manager
  // most needs to hear about. Window is short (90s) so if the same issue
  // keeps happening it still surfaces again soon, rather than staying
  // silent for the rest of the 5-minute window.
  const { name, phone, issue } = req.body || {};
  if (!issue) return res.status(400).json({ ok: false, error: 'Missing issue' });
  const safeName = String(name || 'Unknown').slice(0, 80);
  const safePhone = String(phone || '—').slice(0, 30);
  const safeIssue = String(issue).slice(0, 200);

  if (!rateLimit(`login-issue:${safePhone}:${safeIssue}`, 1, 90 * 1000)) {
    return res.status(200).json({ ok: true, throttled: true });
  }

  try {
    const managers = await sql("SELECT username FROM wf_users WHERE role='manager'");
    const body = `${safeName} (${safePhone}) — ${safeIssue}`;
    const results = await Promise.all(managers.map(m => sendPushToUser(m.username, {
      title: 'Newidra — Login Issue',
      body,
      url: '/?source=push',
      tag: 'login-issue',
    })));
    const sent = results.reduce((a, r) => a + (r.sent || 0), 0);
    return res.status(200).json({ ok: true, sent, managers: managers.length });
  } catch (e) {
    console.error('notify-login-issue failed', e);
    return res.status(500).json({ ok: false, error: 'Could not send notification' });
  }
}
