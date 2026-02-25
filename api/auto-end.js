// /api/auto-end.js — WorkForce Pro Auto-End Cron
// Called every 30 min by cron-job.org
// Uses CommonJS (require) for maximum Vercel compatibility

const { neon } = require('@neondatabase/serverless');

const CRON_SECRET = process.env.CRON_SECRET || null;
const TIMEZONE    = process.env.TIMEZONE || 'Europe/Rome';

module.exports = async function handler(req, res) {

  // ── CORS preflight ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Auth check ──
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // ── DB ──
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ ok: false, error: 'DATABASE_URL not set in Vercel env vars' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const nowUTC = Date.now();

    // ── Local time in Italy (handles CET/CEST automatically) ──
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false
    });

    const parts = {};
    fmt.formatToParts(new Date(nowUTC)).forEach(p => {
      if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
    });

    const localH   = parts.hour;
    const localM   = parts.minute;
    const localDay = parts.day;
    const localMon = parts.month;
    const localYr  = parts.year;

    // Round down to nearest :00 or :30
    const roundedM     = localM < 30 ? 0 : 30;
    const nowTotalMins = localH * 60 + roundedM;

    // Date string in Italian local time
    const today = `${localYr}-${String(localMon).padStart(2,'0')}-${String(localDay).padStart(2,'0')}`;

    const timeLabel = `${localH}:${String(localM).padStart(2,'0')} (${TIMEZONE}) → rounded to ${localH}:${String(roundedM).padStart(2,'0')}`;

    // ── Fetch active shifts ──
    const activeShifts = await sql(
      `SELECT * FROM wf_shifts WHERE status = 'working' AND date = $1`,
      [today]
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
    const locById   = {};
    const locByName = {};
    locations.forEach(l => {
      locById[l.id]     = l;
      locByName[l.name] = l;
    });

    let endedCount = 0;
    const endedWorkers = [];

    for (const shift of activeShifts) {
      // Resolve end_time: per-location → global config → skip
      const loc     = locById[shift.location_id] || locByName[shift.location_name];
      const endTime = (loc && loc.end_time) ? loc.end_time : globalEndTime;
      if (!endTime) continue;

      // Parse + validate HH:MM
      const colonIdx = endTime.indexOf(':');
      if (colonIdx < 0) continue;
      const eh = parseInt(endTime.slice(0, colonIdx), 10);
      const em = parseInt(endTime.slice(colonIdx + 1), 10);
      if (isNaN(eh) || isNaN(em)) continue;
      if (em !== 0 && em !== 30) continue;

      const endTotalMins = eh * 60 + em;

      // Not time yet
      if (nowTotalMins < endTotalMins) continue;

      // Guard: shift started after configured end_time → skip
      const startMs = Number(shift.start_time);
      if (!startMs || startMs <= 0) continue;

      const startFmt = {};
      fmt.formatToParts(new Date(startMs)).forEach(p => {
        if (p.type !== 'literal') startFmt[p.type] = parseInt(p.value, 10);
      });
      const startTotalMins = (startFmt.hour || 0) * 60 + (startFmt.minute || 0);
      if (startTotalMins >= endTotalMins) continue;

      // Calculate hours + earnings
      const wMs       = Math.max(0, nowUTC - startMs);
      const workHours = wMs / 3600000;
      const earnings  = workHours * (parseFloat(shift.hourly_rate) || 0);

      // Update shift — double-end safe
      await sql(
        `UPDATE wf_shifts
         SET status = 'completed', end_time = $2, work_hours = $3, earnings = $4
         WHERE id = $1 AND status = 'working'`,
        [shift.id, nowUTC, workHours, earnings]
      );

      endedCount++;
      endedWorkers.push({
        worker:      shift.worker,
        location:    shift.location_name || '—',
        endTime,
        hours:       Math.round(workHours * 100) / 100
      });

      console.log(`[AutoEnd] ✓ ${shift.worker} @ ${shift.location_name} ended at ${endTime} — ${workHours.toFixed(2)}h`);
    }

    return res.status(200).json({
      ok:      true,
      checked: activeShifts.length,
      ended:   endedCount,
      workers: endedWorkers,
      time:    timeLabel,
      ts:      new Date().toISOString()
    });

  } catch (err) {
    console.error('[AutoEnd] FATAL:', err.message, err.stack);
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
};
