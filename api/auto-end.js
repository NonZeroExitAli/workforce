import { sql } from './_lib.js';

const CRON_SECRET = process.env.CRON_SECRET || null;
const TIMEZONE    = process.env.TIMEZONE || 'Europe/Rome';

// Paid hours always round DOWN to the half hour, as in index.html.
export const payHours = ms => Math.floor(ms / 1800000) / 2;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).send('');

  // ── Auth ──
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  try {
    const nowUTC = Date.now();

    // ── Italian local time (handles CET/CEST automatically) ──
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false
    });

    const parts = {};
    fmt.formatToParts(new Date(nowUTC))
       .forEach(p => { if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10); });

    const localH       = parts.hour;
    const localM       = parts.minute;
    const roundedM     = localM < 30 ? 0 : 30;
    const nowTotalMins = localH * 60 + roundedM;
    const today        = `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;
    const timeLabel    = `${localH}:${String(localM).padStart(2,'0')} ${TIMEZONE} → rounded ${localH}:${String(roundedM).padStart(2,'0')}`;

    // ── Active shifts ──
    const activeShifts = await sql(
      `SELECT id,worker,start_time,billing_start_time,break_minutes,hourly_rate,location_id,location_name
       FROM wf_shifts WHERE status = 'working' AND date = $1`, [today]
    );

    if (!activeShifts.length) {
      return res.status(200).json({ ok: true, checked: 0, ended: 0, time: timeLabel, ts: new Date().toISOString() });
    }

    // ── Locations + config ──
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
      // Resolve end_time: per-location → global → skip
      const loc     = locById[shift.location_id] || locByName[shift.location_name];
      const endTime = loc?.end_time || globalEndTime;
      if (!endTime) continue;

      // Parse + validate HH:MM
      const [eh, em] = endTime.split(':').map(Number);
      if (isNaN(eh) || isNaN(em) || (em !== 0 && em !== 30)) continue;

      const endTotalMins = eh * 60 + em;
      if (nowTotalMins < endTotalMins) continue;

      // Guard: shift started after end_time → skip
      const startMs = Number(shift.start_time);
      if (!startMs || startMs <= 0) continue;

      const sp = {};
      fmt.formatToParts(new Date(startMs))
         .forEach(p => { if (p.type !== 'literal') sp[p.type] = parseInt(p.value, 10); });
      if ((sp.hour * 60 + sp.minute) >= endTotalMins) continue;

      // Same pay rules as _finalizeShift in index.html: billing starts at the
      // official start, stops at the site's end time (not at whenever this ran)
      // and the break comes off without taking a shift below 6 paid hours. Using the raw clock here paid
      // for early arrivals, for the delay before this ran, and for the break.
      const billingStartMs = Number(shift.billing_start_time) || startMs;
      const nowLocalMins   = localH * 60 + localM;
      const endMs          = nowUTC - Math.max(0, nowLocalMins - endTotalMins) * 60000;
      const billedMs       = Math.max(0, endMs - billingStartMs);
      const breakMs        = (parseFloat(shift.break_minutes) || 0) * 60000;
      const minPaidMs      = 6 * 3600000;
      const workHours      = payHours(billedMs <= minPaidMs ? billedMs : Math.max(minPaidMs, billedMs - breakMs));
      const earnings       = workHours * (parseFloat(shift.hourly_rate) || 0);

      await sql(
        `UPDATE wf_shifts SET status='completed', end_time=$2, work_hours=$3, earnings=$4
         WHERE id=$1 AND status='working'`,
        [shift.id, endMs, workHours, earnings]
      );

      endedCount++;
      endedWorkers.push({
        worker:   shift.worker,
        location: shift.location_name || '—',
        endTime,
        hours:    +(workHours.toFixed(2))
      });
      console.log(`[AutoEnd] ✓ ${shift.worker} @ ${shift.location_name} → ${workHours.toFixed(2)}h`);
    }

    return res.status(200).json({
      ok: true, checked: activeShifts.length, ended: endedCount,
      workers: endedWorkers, time: timeLabel, ts: new Date().toISOString()
    });

  } catch (err) {
    console.error('[AutoEnd] ERROR:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// The epoch time of a wall-clock moment in TIMEZONE (handles summer time).
function zonedEpoch(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(guess)).forEach(x => { if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10); });
  const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  return guess - (shown - guess);
}

// Shifts still running from an earlier day are closed at their site's end
// time (or the global one) with the usual pay rules; with no end time to go
// by they are marked for review. Same rules as reconcileStaleShifts in
// index.html, run daily by /api/check-notifications so it doesn't depend on
// anyone opening the app.
export async function closeStaleShifts(today) {
  const stale = await sql(
    `SELECT id,date,start_time,billing_start_time,break_minutes,hourly_rate,location_id
     FROM wf_shifts WHERE status='working' AND date < $1`, [today]
  );
  if (!stale.length) return 0;
  const [locations, configRows] = await Promise.all([
    sql('SELECT id, end_time FROM wf_locations'),
    sql('SELECT auto_end_time FROM wf_config WHERE id = 1 LIMIT 1')
  ]);
  const endById = {};
  locations.forEach(l => { endById[l.id] = l.end_time; });
  const globalEnd = configRows[0]?.auto_end_time || null;
  let closed = 0;
  for (const s of stale) {
    const cut = (s.location_id && endById[s.location_id]) || globalEnd;
    const [y, mo, d] = String(s.date || '').split('-').map(Number);
    const [ch, cm] = String(cut || '').split(':').map(Number);
    if (!cut || [y, mo, d, ch, cm].some(n => isNaN(n))) {
      await sql("UPDATE wf_shifts SET status='needs_review' WHERE id=$1 AND status='working'", [s.id]);
      continue;
    }
    // "00:00" means midnight at the end of that day.
    const endMs = zonedEpoch(y, mo, ch === 0 && cm === 0 ? d + 1 : d, ch, cm);
    const billedMs = Math.max(0, endMs - (Number(s.billing_start_time) || Number(s.start_time)));
    const breakMs = (parseFloat(s.break_minutes) || 0) * 60000;
    const minPaidMs = 6 * 3600000;
    const workHours = payHours(billedMs <= minPaidMs ? billedMs : Math.max(minPaidMs, billedMs - breakMs));
    await sql(
      `UPDATE wf_shifts SET status='completed', end_time=$2, work_hours=$3, earnings=$4 WHERE id=$1 AND status='working'`,
      [s.id, endMs, workHours, workHours * (parseFloat(s.hourly_rate) || 0)]
    );
    closed++;
  }
  return closed;
}
