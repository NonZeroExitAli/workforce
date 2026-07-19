// ─────────────────────────────────────────────────────────────
// /api/push-subscribe-worker — registers a worker's device for push
// notifications.
//
// Workers don't have a password or a server-side session (they sign in
// with just a phone number, locked to one device ID — see login flow in
// index.html). So this can't be gated with verifySession() like the
// manager version. Instead it's gated the same way the rest of the app
// already trusts a worker's identity: the caller must supply the exact
// device_id already stored on that worker's account. That device_id was
// set the first time the worker signed in on their phone, so only that
// same phone can pass this check — someone who only knows a worker's
// phone number, without also controlling their registered device, can't
// subscribe on their behalf.
//
//   POST    → save a PushSubscription for a worker, if deviceId matches.
//   DELETE  → remove it (same deviceId check).
// ─────────────────────────────────────────────────────────────
import { sql, setCors, rateLimit, clientIp } from './_lib.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

  // No session token exists to gate this endpoint (see note above), so it
  // leans more heavily on rate limiting than the manager version does —
  // this makes guessing at valid username/deviceId combinations impractical.
  if (!rateLimit(`push-sub-worker:${clientIp(req)}`, 20, 5 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests.' });
  }

  try {
    const { username, deviceId } = req.body || {};
    if (!username || !deviceId) {
      return res.status(400).json({ ok: false, error: 'Missing username or deviceId' });
    }

    const rows = await sql("SELECT username,device_id FROM wf_users WHERE username=$1 AND role='worker' LIMIT 1", [username]);
    const worker = rows[0];
    if (!worker || !worker.device_id || worker.device_id !== deviceId) {
      return res.status(401).json({ ok: false, error: 'Not authorized for this account' });
    }

    if (req.method === 'POST') {
      const { subscription } = req.body || {};
      const endpoint = subscription && subscription.endpoint;
      const p256dh = subscription && subscription.keys && subscription.keys.p256dh;
      const auth = subscription && subscription.keys && subscription.keys.auth;
      if (!endpoint || !p256dh || !auth) {
        return res.status(400).json({ ok: false, error: 'Invalid subscription' });
      }
      const existing = await sql('SELECT id FROM wf_push_subscriptions WHERE endpoint=$1 LIMIT 1', [endpoint]);
      if (existing[0]) {
        await sql('UPDATE wf_push_subscriptions SET username=$1,p256dh=$2,auth=$3 WHERE id=$4', [username, p256dh, auth, existing[0].id]);
      } else {
        const id = crypto.randomBytes(12).toString('hex');
        await sql(
          'INSERT INTO wf_push_subscriptions(id,username,endpoint,p256dh,auth,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [id, username, endpoint, p256dh, auth, Date.now()]
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { endpoint } = req.body || {};
      if (!endpoint) return res.status(400).json({ ok: false, error: 'Missing endpoint' });
      await sql('DELETE FROM wf_push_subscriptions WHERE username=$1 AND endpoint=$2', [username, endpoint]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('push-subscribe-worker failed', e);
    return res.status(500).json({ ok: false, error: 'Could not save subscription' });
  }
}
