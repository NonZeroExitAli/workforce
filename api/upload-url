// ─────────────────────────────────────────────────────────────
// /api/upload-url    →  gives the browser a temporary permission
//                       slip to upload ONE file directly to storage.
//
// The file never passes through this server, so there's no upload
// size limit to worry about and it costs you no bandwidth.
// ─────────────────────────────────────────────────────────────
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contentType, owner } = req.body || {};

    const ext = ALLOWED[contentType];
    if (!ext) return res.status(415).json({ error: 'Only JPG, PNG, WebP or PDF' });

    const safeOwner = String(owner || 'misc').replace(/[^\w.-]/g, '_');
    const key = `${safeOwner}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

    // Valid for 2 minutes — long enough to upload, short enough to be safe.
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 120 }
    );

    return res.status(200).json({ key, url });
  } catch (e) {
    console.error('upload-url failed', e);
    return res.status(500).json({ error: 'Could not prepare upload' });
  }
}
