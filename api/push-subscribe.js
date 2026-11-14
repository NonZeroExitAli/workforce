// ─────────────────────────────────────────────────────────────
// /api/push-subscribe — registers/unregisters a device for push
// notifications. Handles BOTH managers and workers — this used to be two
// separate files (push-subscribe.js + push-subscribe-worker.js) but
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and
// the app was over that limit, so they were merged.
//
// The two roles authenticate differently, since only managers have a
// real server-side session:
//   - Manager: identified by the session token in the Authorization
//     header (same as every other manager-only endpoint).
//   - Worker: has no session — workers sign in with just a phone number
//     locked to one device ID (see login flow in index.html). So a
//     worker request instead proves identity by sending {username,
//     deviceId} in the body, checked against the device_id already
//     stored on that worker's account. Only the phone that account
//     actually signed in on can pass this — someone who only knows a
//     worker's phone number, without controlling their registered
//     device, can't subscribe on their behalf.
//
//   POST    → save a browser PushSubscription for whichever identity
//             above the request proves. Safe to call again from the
//             same device (upserts on endpoint).
//   DELETE  → remove a subscription.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, verifySession, verifyWorkerDevice, rateLimit, clientIp } from './_lib.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

  let identity = null;

  const session = await verifySession(req);
  if (session && session.role === 'manager') {
    identity = session.username;
  } else {
    // No session exists for workers, so this path leans more heavily on
    // rate limiting than the manager path does — makes guessing at valid
    // username/deviceId combinations impractical.
    if (!rateLimit(`push-sub-worker:${clientIp(req)}`, 20, 5 * 60 * 1000)) {
      return res.status(429).json({ ok: false, error: 'Too many requests.' });
    }
    const { username, deviceId } = req.body || {};
    if (!(await verifyWorkerDevice(username, deviceId))) {
      return res.status(401).json({ ok: false, error: 'Not authorized for this account' });
    }
    identity = username;
  }

  try {
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
        await sql('UPDATE wf_push_subscriptions SET username=$1,p256dh=$2,auth=$3 WHERE id=$4', [identity, p256dh, auth, existing[0].id]);
      } else {
        const id = crypto.randomBytes(12).toString('hex');
        await sql(
          'INSERT INTO wf_push_subscriptions(id,username,endpoint,p256dh,auth,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [id, identity, endpoint, p256dh, auth, Date.now()]
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { endpoint } = req.body || {};
      if (!endpoint) return res.status(400).json({ ok: false, error: 'Missing endpoint' });
      await sql('DELETE FROM wf_push_subscriptions WHERE username=$1 AND endpoint=$2', [identity, endpoint]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('push-subscribe failed', e);
    return res.status(500).json({ ok: false, error: 'Could not save subscription' });
  }
}
