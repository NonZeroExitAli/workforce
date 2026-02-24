import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.NEON_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

    const result = await pool.query(query, Array.isArray(params) ? params : []);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ ok: true, rows: result.rows });
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
