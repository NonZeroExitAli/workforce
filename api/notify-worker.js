// ─────────────────────────────────────────────────────────────
// /api/notify-worker — sends one push notification to one worker,
// right now (no cron, no delay).
//
// Requires a signed-in manager session — only the manager screens ever
// call this, at the exact moment something worth telling a worker about
// happens (e.g. they were just assigned to a site).
// ─────────────────────────────────────────────────────────────
import { setCors, verifySession, sendPushToUser } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const session = await verifySession(req);
  if (!session || session.role !== 'manager') {
    return res.status(401).json({ ok: false, error: 'Not authorized' });
  }

  try {
    const { username, title, body, url } = req.body || {};
    if (!username || !body) return res.status(400).json({ ok: false, error: 'Missing username or body' });
    const result = await sendPushToUser(username, {
      title: title || 'Newidra',
      body,
      url: url || '/?source=push',
      tag: 'assignment',
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('notify-worker failed', e);
    return res.status(500).json({ ok: false, error: 'Could not send notification' });
  }
}
