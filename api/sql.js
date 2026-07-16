// ─────────────────────────────────────────────────────────────
// /api/sql — every query in the app goes through this one endpoint.
//
// Uses Neon's HTTP driver instead of a pg.Pool TCP connection. A pg.Pool
// on a serverless function has to open a fresh TCP+TLS handshake to
// Postgres on every cold start (and often on warm ones too, since Vercel
// doesn't guarantee the same instance stays alive between requests).
// Neon's HTTP driver skips that entirely — it's a single HTTPS request
// straight to Neon's edge, so latency per query drops significantly,
// especially for the "first query after a bit of idle time" case that
// was causing the multi-second lag.
// ─────────────────────────────────────────────────────────────
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    return res.status(200).send("");
  }

  if (req.method !== "POST") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(405).send("POST only");
  }

  try {
    const { query, params } = req.body || {};
    if (!query) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(400).json({ ok: false, error: "Missing query" });
    }

    const rows = await sql(query, Array.isArray(params) ? params : []);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ ok: true, rows });
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
