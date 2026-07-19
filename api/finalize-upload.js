// ─────────────────────────────────────────────────────────────
// /api/finalize-upload — real, server-enforced max file size.
//
// R2 presigned PUT URLs (unlike S3) don't support POST-policy
// content-length-range conditions, so the size cap can't be baked into
// the presigned URL itself — the client-side checks in the app were the
// only thing stopping an oversized upload (bypassable by anyone calling
// the API directly).
//
// This closes that gap the way R2 supports: after the browser PUTs the
// file straight to R2, the client calls this endpoint with the object
// key. It HEADs the real, now-stored object size and — if it's over the
// cap — deletes it immediately and reports failure, so nothing over the
// limit is ever kept or referenced in the database. The one-time window
// where an oversized file briefly exists in the bucket costs storage for
// a few seconds at most, never bandwidth through this server.
// ─────────────────────────────────────────────────────────────
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { setCors, verifySession } from './_lib.js';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB hard cap

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const session = await verifySession(req);
  if (!session || session.role !== 'manager') {
    return res.status(401).json({ ok: false, error: 'Not authorized' });
  }

  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });

    const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    const size = Number(head.ContentLength || 0);

    if (size > MAX_UPLOAD_BYTES) {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })).catch(() => {});
      return res.status(413).json({ ok: false, error: `File too large (max ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB)` });
    }

    return res.status(200).json({ ok: true, size });
  } catch (e) {
    console.error('finalize-upload failed', e);
    return res.status(500).json({ ok: false, error: 'Could not verify upload' });
  }
}
