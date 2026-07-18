// ─────────────────────────────────────────────────────────────
// /api/_lib.js — shared helpers for the API routes.
//
// A file starting with "_" is NOT treated as a route by Vercel, so this
// can be imported by the other /api files without becoming its own
// public endpoint.
// ─────────────────────────────────────────────────────────────
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export const sql = neon(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);

// Locks CORS down to the real app origin instead of "*". Set APP_ORIGIN in
// Vercel's environment variables if you ever move to a custom domain.
export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_ORIGIN || 'https://workforce-omega.vercel.app');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST,DELETE,GET,OPTIONS');
}

export async function createSession(username, role, days = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires = now + days * 24 * 60 * 60 * 1000;
  await sql(
    'INSERT INTO wf_sessions(token,username,role,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
    [token, username, role, now, expires]
  );
  return { token, expires };
}

// Reads "Authorization: Bearer <token>" and returns the session row, or null.
export async function verifySession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  const rows = await sql('SELECT token,username,role,expires_at FROM wf_sessions WHERE token=$1 LIMIT 1', [token]);
  const s = rows[0];
  if (!s) return null;
  if (Number(s.expires_at) < Date.now()) return null;
  return s;
}

export const bcryptHash = (pw) => bcrypt.hash(pw, 10);
export const bcryptCompare = (pw, hash) => bcrypt.compare(pw, hash);
export const looksHashed = (pw) => typeof pw === 'string' && /^\$2[aby]\$/.test(pw);
