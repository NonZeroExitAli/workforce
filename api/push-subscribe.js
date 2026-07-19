// ─────────────────────────────────────────────────────────────
// /api/push-subscribe — registers/unregisters this device for push
// notifications, tied to the signed-in manager's account.
//
//   POST    → save a browser PushSubscription (endpoint + keys) for the
//             signed-in manager. Safe to call again from the same device
//             (upserts on endpoint).
//   DELETE  → remove a subscription (e.g. the user disabled notifications).
// ─────────────────────────────────────────────────────────────
import { sql, setCors, verifySession } from './_lib.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

  const session = await verifySession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Not signed in' });

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
        await sql('UPDATE wf_push_subscriptions SET username=$1,p256dh=$2,auth=$3 WHERE id=$4', [session.username, p256dh, auth, existing[0].id]);
      } else {
        const id = crypto.randomBytes(12).toString('hex');
        await sql(
          'INSERT INTO wf_push_subscriptions(id,username,endpoint,p256dh,auth,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [id, session.username, endpoint, p256dh, auth, Date.now()]
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { endpoint } = req.body || {};
      if (!endpoint) return res.status(400).json({ ok: false, error: 'Missing endpoint' });
      await sql('DELETE FROM wf_push_subscriptions WHERE username=$1 AND endpoint=$2', [session.username, endpoint]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('push-subscribe failed', e);
    return res.status(500).json({ ok: false, error: 'Could not save subscription' });
  }
}
