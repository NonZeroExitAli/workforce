// ─────────────────────────────────────────────────────────────
// /api/storage — everything that touches Cloudflare R2 object storage,
// combined into one endpoint. This used to be three separate files
// (upload-url.js, finalize-upload.js, file.js) but Vercel's Hobby plan
// caps a deployment at 12 serverless functions total, and the app was
// over that limit — so these were merged to make room without losing
// any behavior. All four operations still work exactly as before, just
// reached through one route instead of three.
//
//   POST   {action:'upload-url', contentType, owner}
//            → a temporary permission slip (presigned PUT URL) so the
//              browser can upload ONE file straight to R2. The file
//              never passes through this server.
//
//   POST   {action:'finalize', key}
//            → real, server-enforced max file size. R2's presigned PUT
//              URLs don't support a size condition the way S3's POST
//              policies do, so this is the workaround: after the browser
//              PUTs the file, it calls this with the object key. If the
//              real, now-stored object is over the cap, it's deleted
//              immediately and nothing is ever kept or referenced.
//
//   GET    ?key=...
//            → a link that works for 5 minutes, then dies. Keeps ID
//              cards and residence permits private (the bucket itself is
//              never public).
//
//   DELETE ?key=...
//            → removes the file from storage.
//
//   POST   {action:'sign-many', keys}
//            → the same 5-minute links for a whole roster of photos in one
//              request, instead of one request (and session check) per photo.
//
//   POST   {action:'read-base64', key}
//            → one small image as base64, for the Excel export when the
//              bucket's CORS rules don't allow the browser to read it.
//
// All of the above require a valid, signed-in manager session.
//
// Workers can only touch their OWN profile photo, proved by the device ID
// locked to their account, and the server decides which file that is:
//
//   POST   {action:'worker-upload-url', username, deviceId}
//   POST   {action:'worker-finalize', username, deviceId, key}
//   POST   {action:'worker-photo-read', username, deviceId}
// ─────────────────────────────────────────────────────────────
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { sql, setCors, verifySession, verifyWorkerDevice, rateLimit, clientIp, audit } from './_lib.js';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB hard cap

const MAX_WORKER_PHOTO_BYTES = 3 * 1024 * 1024;
const WORKER_ACTIONS = new Set(['worker-upload-url', 'worker-finalize', 'worker-photo-read']);
const _safeOwner = (owner) => String(owner || 'misc').replace(/[^\w.-]/g, '_');
const _signGet = (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), { expiresIn: 300 });

async function handleWorkerPhoto(req, res) {
  if (!rateLimit(`worker-photo:${clientIp(req)}`, 60, 5 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Too many requests.' });
  }
  const { action, username, deviceId, key } = req.body;
  if (!(await verifyWorkerDevice(username, deviceId))) {
    return res.status(401).json({ ok: false, error: 'Not authorized for this account' });
  }

  if (action === 'worker-photo-read') {
    const rows = await sql('SELECT photo_url FROM wf_users WHERE username=$1 LIMIT 1', [username]);
    const ref = rows[0]?.photo_url;
    if (!ref || ref.indexOf('obj:') !== 0) return res.status(200).json({ ok: true, url: null });
    return res.status(200).json({ ok: true, url: await _signGet(ref.slice(4)) });
  }

  const prefix = `${_safeOwner(username)}/`;

  if (action === 'worker-upload-url') {
    const newKey = `${prefix}${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: newKey, ContentType: 'image/jpeg' }),
      { expiresIn: 120 }
    );
    return res.status(200).json({ ok: true, key: newKey, url });
  }

  // worker-finalize — the key must sit under this worker's own folder.
  if (typeof key !== 'string' || !key.startsWith(prefix) || key.includes('..')) {
    return res.status(403).json({ ok: false, error: 'Not your file' });
  }
  const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  if (Number(head.ContentLength || 0) > MAX_WORKER_PHOTO_BYTES) {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })).catch(() => {});
    return res.status(413).json({ ok: false, error: 'Photo too large' });
  }
  const rows = await sql('SELECT photo_url FROM wf_users WHERE username=$1 LIMIT 1', [username]);
  const oldRef = rows[0]?.photo_url;
  const ref = `obj:${key}`;
  await sql("UPDATE wf_users SET photo_url=$1 WHERE username=$2 AND role='worker'", [ref, username]);
  if (oldRef && oldRef.indexOf('obj:') === 0 && oldRef !== ref) {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: oldRef.slice(4) })).catch(() => {});
  }
  await audit(username, 'worker_photo_self_upload', username, {});
  return res.status(200).json({ ok: true, ref, url: await _signGet(key) });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

  if (req.method === 'POST' && WORKER_ACTIONS.has(req.body?.action)) {
    try {
      return await handleWorkerPhoto(req, res);
    } catch (e) {
      console.error('worker photo op failed', e);
      return res.status(500).json({ ok: false, error: 'Storage operation failed' });
    }
  }

  const session = await verifySession(req);
  if (!session || session.role !== 'manager') {
    return res.status(401).json({ ok: false, error: 'Not authorized' });
  }

  try {
    if (req.method === 'GET') {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: 'Missing key' });
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
        { expiresIn: 300 }
      );
      return res.status(200).json({ url });
    }

    if (req.method === 'DELETE') {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: 'Missing key' });
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
      return res.status(200).json({ deleted: true });
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};

      if (action === 'sign-many') {
        const keys = Array.isArray(req.body?.keys) ? req.body.keys.slice(0, 300) : [];
        const urls = {};
        await Promise.all(keys.map(async (k) => {
          urls[k] = await _signGet(String(k));
        }));
        return res.status(200).json({ ok: true, urls });
      }

      if (action === 'read-base64') {
        const { key } = req.body || {};
        if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
        const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
        if (Number(obj.ContentLength || 0) > MAX_WORKER_PHOTO_BYTES) {
          return res.status(413).json({ ok: false, error: 'File too large' });
        }
        const bytes = await obj.Body.transformToByteArray();
        return res.status(200).json({ ok: true, contentType: obj.ContentType, base64: Buffer.from(bytes).toString('base64') });
      }

      if (action === 'upload-url') {
        const { contentType, owner } = req.body || {};
        const ext = ALLOWED[contentType];
        if (!ext) return res.status(415).json({ error: 'Only JPG, PNG, WebP or PDF' });
        const safeOwner = String(owner || 'misc').replace(/[^\w.-]/g, '_');
        const key = `${safeOwner}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
        // Valid for 2 minutes — long enough to upload, short enough to be safe.
        const url = await getSignedUrl(
          s3,
          new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: contentType }),
          { expiresIn: 120 }
        );
        return res.status(200).json({ key, url });
      }

      if (action === 'finalize') {
        const { key } = req.body || {};
        if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
        const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
        const size = Number(head.ContentLength || 0);
        if (size > MAX_UPLOAD_BYTES) {
          await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })).catch(() => {});
          return res.status(413).json({ ok: false, error: `File too large (max ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB)` });
        }
        return res.status(200).json({ ok: true, size });
      }

      return res.status(400).json({ ok: false, error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('storage op failed', e);
    return res.status(500).json({ error: 'Storage operation failed' });
  }
}
