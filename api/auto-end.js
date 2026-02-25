// /api/auto-end.js — WorkForce Pro Auto-End Cron
// Uses the same /api/sql endpoint your app already uses — no npm packages needed.

const CRON_SECRET = process.env.CRON_SECRET || null;
const TIMEZONE    = process.env.TIMEZONE || 'Europe/Rome';

// ── Call your own /api/sql endpoint (same as the browser does) ──
async function sql(query, params = []) {
  // Build the absolute URL using Vercel's own env var
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const res = await fetch(`${base}/api/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, params })
  });

  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    throw new Error(data?.error || `SQL failed (${res.status}): ${query.slice(0, 80)}`);
  }
  return data.rows || [];
}

module.exports = async function handler(req, res) {

  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Auth ──
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized — wrong CRON_SECRET' });
    }
  }

  try {
    const nowUTC = Date.now();

    // ── Italian local time (CET/CEST auto) ──
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false
    });

    const parts = {};
    fmt.formatToParts(new Date(nowUTC))
       .forEach(p => { if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10); });

    const localH = parts.hour;
    const localM = parts.minute;
    const roundedM     = localM < 30 ? 0 : 30;
    const nowTotalMins = localH * 60 + roundedM;
    const today = `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;
    const timeLabel = `${localH}:${String(localM).padStart(2,'0')} ${TIMEZONE} → rounded ${localH}:${String(roundedM).padStart(2,'0')}`;

    // ── Fetch active shifts ──
    const activeShifts = await sql(
      `SELECT * FROM wf_shifts WHERE status = 'working' AND date = $1`, [today]
    );

    if (!activeShifts.length) {
      return res.status(200).json({ ok: true, checked: 0, ended: 0, time: timeLabel, ts: new Date().toISOString() });
    }

    // ── Fetch locations + config ──
    const [locations, configRows] = await Promise.all([
      sql('SELECT id, name, end_time FROM wf_locations'),
      sql('SELECT auto_end_time FROM wf_config WHERE id = 1 LIMIT 1')
    ]);

    const globalEndTime = configRows[0]?.auto_end_time || null;
    const locById = {}, locByName = {};
    locations.forEach(l => { locById[l.id] = l; locByName[l.name] = l; });

    let endedCount = 0;
    const endedWorkers = [];

    for (const shift of activeShifts) {
      const loc     = locById[shift.location_id] || locByName[shift.location_name];
      const endTime = loc?.end_time || globalEndTime;
      if (!endTime) continue;

      const [eh, em] = endTime.split(':').map(Number);
      if (isNaN(eh) || isNaN(em) || (em !== 0 && em !== 30)) continue;

      const endTotalMins = eh * 60 + em;
      if (nowTotalMins < endTotalMins) continue;

      const startMs = Number(shift.start_time);
      if (!startMs || startMs <= 0) continue;

      const sp = {};
      fmt.formatToParts(new Date(startMs))
         .forEach(p => { if (p.type !== 'literal') sp[p.type] = parseInt(p.value, 10); });
      if ((sp.hour * 60 + sp.minute) >= endTotalMins) continue;

      const wMs       = Math.max(0, nowUTC - startMs);
      const workHours = wMs / 3600000;
      const earnings  = workHours * (parseFloat(shift.hourly_rate) || 0);

      await sql(
        `UPDATE wf_shifts SET status='completed', end_time=$2, work_hours=$3, earnings=$4
         WHERE id=$1 AND status='working'`,
        [shift.id, nowUTC, workHours, earnings]
      );

      endedCount++;
      endedWorkers.push({ worker: shift.worker, location: shift.location_name || '—', endTime, hours: +(workHours.toFixed(2)) });
      console.log(`[AutoEnd] ✓ ${shift.worker} ended at ${endTime} — ${workHours.toFixed(2)}h`);
    }

    return res.status(200).json({
      ok: true, checked: activeShifts.length, ended: endedCount,
      workers: endedWorkers, time: timeLabel, ts: new Date().toISOString()
    });

  } catch (err) {
    console.error('[AutoEnd] ERROR:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
