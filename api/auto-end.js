// ══════════════════════════════════════════════════════════════
//  /api/auto-end.js  —  WorkForce Pro Auto-End Cron
//
//  Called every 30 minutes by cron-job.org.
//  FIXED: Uses Europe/Rome timezone so end times match what
//         the manager configured in the app (Italian local time).
//
//  Environment variables required:
//    DATABASE_URL = postgresql://...   (your Neon connection string)
//    CRON_SECRET  = any-random-string  (set in Vercel env vars)
//    TIMEZONE     = Europe/Rome        (set in Vercel env vars — optional, defaults to Europe/Rome)
// ══════════════════════════════════════════════════════════════

import { neon } from '@neondatabase/serverless';

const CRON_SECRET = process.env.CRON_SECRET || null;
const TIMEZONE    = process.env.TIMEZONE || 'Europe/Rome';

export default async function handler(req, res) {

  // ── Auth check ──
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const nowUTC = Date.now();

    // ── Get current time in Italy (Europe/Rome) ──
    // Intl.DateTimeFormat gives us the LOCAL hour/minute/date in the correct timezone,
    // even accounting for DST (CET = UTC+1, CEST = UTC+2 in summer).
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE,
      year:   'numeric', month:  '2-digit', day:    '2-digit',
      hour:   '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });

    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(nowUTC))
         .filter(p => p.type !== 'literal')
         .map(p => [p.type, parseInt(p.value, 10)])
    );

    const localH    = parts.hour;
    const localM    = parts.minute;
    const localDay  = parts.day;
    const localMon  = parts.month;   // 1-12
    const localYear = parts.year;

    // Round minutes down to nearest :00 or :30
    const roundedM      = localM < 30 ? 0 : 30;
    const nowTotalMins  = localH * 60 + roundedM;

    // Today's date string in local time (YYYY-MM-DD)
    const today = `${localYear}-${String(localMon).padStart(2,'0')}-${String(localDay).padStart(2,'0')}`;

    const timeLabel = `${localH}:${String(localM).padStart(2,'0')} ${TIMEZONE} → rounded ${localH}:${String(roundedM).padStart(2,'0')}`;

    // Fetch all active shifts for today
    const activeShifts = await sql(
      `SELECT * FROM wf_shifts WHERE status = 'working' AND date = $1`,
      [today]
    );

    if (!activeShifts.length) {
      return res.status(200).json({
        ok: true, checked: 0, ended: 0,
        time: timeLabel,
        ts: new Date().toISOString()
      });
    }

    // Fetch locations and global config in parallel
    const [locations, configRows] = await Promise.all([
      sql('SELECT * FROM wf_locations'),
      sql('SELECT * FROM wf_config WHERE id = 1 LIMIT 1')
    ]);

    const globalEndTime = configRows[0]?.auto_end_time || null;
    const locMap = {};
    locations.forEach(l => { locMap[l.id] = l; });

    let endedCount = 0;
    const endedWorkers = [];

    for (const shift of activeShifts) {
      // Resolve end_time: location-specific → global config → skip
      const loc = locMap[shift.location_id] ||
                  locations.find(l => l.name === shift.location_name);
      const endTime = loc?.end_time || globalEndTime;
      if (!endTime) continue;

      // Parse end time — must be HH:MM on the hour or half-hour
      const [eh, em] = endTime.split(':').map(Number);
      if (isNaN(eh) || isNaN(em)) continue;
      if (em !== 0 && em !== 30) continue;

      const endTotalMins = eh * 60 + em;

      // Fire if current local time >= end time
      if (nowTotalMins < endTotalMins) continue;

      // Guard: don't end a shift that started at or after the end time
      const startMs = Number(shift.start_time);
      // Convert start_time to local time for comparison
      const startParts = Object.fromEntries(
        fmt.formatToParts(new Date(startMs))
           .filter(p => p.type !== 'literal')
           .map(p => [p.type, parseInt(p.value, 10)])
      );
      const startTotalMins = startParts.hour * 60 + startParts.minute;
      if (startTotalMins >= endTotalMins) continue;

      // Calculate hours and earnings
      const endMs    = nowUTC;
      const wMs      = Math.max(0, endMs - startMs);
      const workHours = wMs / 3600000;
      const earnings  = workHours * (parseFloat(shift.hourly_rate) || 0);

      // End the shift — WHERE status='working' prevents double-ending
      await sql(
        `UPDATE wf_shifts
         SET status = 'completed', end_time = $2, work_hours = $3, earnings = $4
         WHERE id = $1 AND status = 'working'`,
        [shift.id, endMs, workHours, earnings]
      );

      endedCount++;
      endedWorkers.push({
        worker:      shift.worker,
        location:    shift.location_name,
        endTime,
        hoursWorked: Math.round(workHours * 100) / 100
      });

      console.log(`[AutoEnd] Ended ${shift.id} | ${shift.worker} | endTime: ${endTime} | hours: ${workHours.toFixed(2)}`);
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
    console.error('[AutoEnd] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
