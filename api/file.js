// ─────────────────────────────────────────────────────────────
// /api/file?key=...
//
//   GET     → returns a link that works for 5 minutes, then dies.
//             This is what keeps ID cards and residence permits
//             private: the bucket itself is never public.
//   DELETE  → removes the file from storage.
//
// Both require a valid, signed-in manager session — only the manager
// screens ever call this endpoint (workers never view/upload/delete
// documents directly), so this is a full, non-bypassable gate rather
// than a best-effort check.
// ─────────────────────────────────────────────────────────────
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { setCors, verifySession } from './_lib.js';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const session = await verifySession(req);
  if (!session || session.role !== 'manager') {
    return res.status(401).json({ error: 'Not authorized' });
  }

  try {
    if (req.method === 'DELETE') {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
      return res.status(200).json({ deleted: true });
    }

    if (req.method === 'GET') {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
        { expiresIn: 300 } // 5 minutes
      );
      return res.status(200).json({ url });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('file op failed', e);
    return res.status(500).json({ error: 'File operation failed' });
  }
}
