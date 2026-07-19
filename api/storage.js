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
// All four require a valid, signed-in manager session — only the manager
// screens ever call this (workers never view/upload/delete documents
// directly), so this is a full, non-bypassable gate rather than a
// best-effort check.
// ─────────────────────────────────────────────────────────────
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { setCors, verifySession } from './_lib.js';

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

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

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
