// ══════════════════════════════════════════════════════════════
//  /api/auto-end.js  —  WorkForce Pro Auto-End Cron
//
//  Called every 30 minutes by cron-job.org.
//  End times are always on the hour or half-hour (e.g. 16:00, 16:30).
//  Checks all active shifts and ends any that have reached their
//  location's configured end_time. Works with no browser open.
//
//  cron-job.org schedule:  every 30 minutes
//  Cron expression:        */30 * * * *
//
//  Environment variables required (same as your /api/sql):
//    DATABASE_URL = postgresql://...   (your Neon connection string)
//    CRON_SECRET  = any-random-string  (set in Vercel env vars)
// ══════════════════════════════════════════════════════════════

import { neon } from '@neondatabase/serverless';

const CRON_SECRET = process.env.CRON_SECRET || null;

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
    const now = Date.now();
    const nowDate = new Date(now);
    const nowH = nowDate.getHours();
    const nowM = nowDate.getMinutes();

    // Since we run every 30 minutes and end times are always :00 or :30,
    // we round current minutes down to the nearest half-hour for comparison.
    // This handles the case where the cron fires at e.g. 16:02 instead of exactly 16:00.
    const roundedM = nowM < 30 ? 0 : 30;
    const nowTotalMins = nowH * 60 + roundedM;

    // Today's date string YYYY-MM-DD
    const today = [
      nowDate.getFullYear(),
      String(nowDate.getMonth() + 1).padStart(2, '0'),
      String(nowDate.getDate()).padStart(2, '0')
    ].join('-');

    // Fetch all active shifts for today
    const activeShifts = await sql(
      `SELECT * FROM wf_shifts WHERE status = 'working' AND date = $1`,
      [today]
    );

    if (!activeShifts.length) {
      return res.status(200).json({
        ok: true, checked: 0, ended: 0,
        time: `${nowH}:${String(nowM).padStart(2,'0')} (rounded to ${nowH}:${String(roundedM).padStart(2,'0')})`,
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
      if (em !== 0 && em !== 30) continue; // safety check

      const endTotalMins = eh * 60 + em;

      // Fire if current rounded time matches or has passed the end time
      if (nowTotalMins < endTotalMins) continue;

      // Don't end a shift that started at or after the end time (misconfiguration guard)
      const startMs = Number(shift.start_time);
      const startDate = new Date(startMs);
      const startTotalMins = startDate.getHours() * 60 + startDate.getMinutes();
      if (startTotalMins >= endTotalMins) continue;

      // Calculate hours and earnings
      const endMs = now;
      const wMs = Math.max(0, endMs - startMs);
      const workHours = wMs / 3600000;
      const earnings = workHours * (parseFloat(shift.hourly_rate) || 0);

      // End the shift — use WHERE status='working' to prevent double-ending
      const result = await sql(
        `UPDATE wf_shifts
         SET status = 'completed', end_time = $2, work_hours = $3, earnings = $4
         WHERE id = $1 AND status = 'working'`,
        [shift.id, endMs, workHours, earnings]
      );

      endedCount++;
      endedWorkers.push({
        worker: shift.worker,
        location: shift.location_name,
        endTime,
        hoursWorked: Math.round(workHours * 100) / 100
      });

      console.log(`[AutoEnd] Ended shift ${shift.id} | worker: ${shift.worker} | location: ${shift.location_name} | endTime: ${endTime} | hours: ${workHours.toFixed(2)}`);
    }

    return res.status(200).json({
      ok: true,
      checked: activeShifts.length,
      ended: endedCount,
      workers: endedWorkers,
      time: `${nowH}:${String(nowM).padStart(2,'0')} (rounded to ${nowH}:${String(roundedM).padStart(2,'0')})`,
      ts: new Date().toISOString()
    });

  } catch (err) {
    console.error('[AutoEnd] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
