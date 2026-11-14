// ─────────────────────────────────────────────────────────────
// /api/check-notifications — the engine behind push notifications.
// Meant to be pinged every ~10 minutes, all day, by a free external cron
// service (see setup notes) — Vercel's free plan only allows a cron job
// to run once a day, too infrequent for "your shift ends in 10 minutes".
//
// Two independent things happen on every call:
//
//   1. MORNING BATCH (only actually runs during the 07:00 Rome-time hour,
//      once per day — every other ping this hour is a no-op):
//        - Managers: one digest push ("N items need attention") if
//          anything is expiring — full detail stays in the in-app
//          Notifications tab, the push is just a nudge to go look.
//        - Workers: a push about their OWN contract_expiry only (not
//          other documents) if it's entering the expiry window.
//
//   2. SHIFT-ENDING CHECK (runs every call): any worker still clocked in
//      whose site's auto-end time is within the next 10 minutes gets a
//      push reminding THEM (not the manager) to end their shift.
//
// Every alert is deduplicated through wf_notified_log so pinging this
// frequently never sends the same thing twice.
// ─────────────────────────────────────────────────────────────
import { sql, setCors, sendPushToUser } from './_lib.js';

const TZ = 'Europe/Rome'; // the app's real-world users are in Italy

function _romeNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    hh: Number(get('hour')),
    mm: Number(get('minute')),
  };
}

// Counted from today's date in Rome, not the server's clock (UTC), so an item
// can't be a day off around midnight.
function _daysUntil(iso, todayStr) {
  if (!iso) return null;
  const target = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(target)) return null;
  return Math.round((target - Date.parse(todayStr + 'T00:00:00Z')) / 86400000);
}

function _nextRentDue(day, todayStr) {
  const d = parseInt(day, 10);
  if (!(d >= 1 && d <= 31)) return null;
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const now = new Date(ty, tm - 1, td);
  const mk = (y, m) => {
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(d, last));
  };
  let due = mk(now.getFullYear(), now.getMonth());
  if (due < now) due = mk(now.getFullYear(), now.getMonth() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${due.getFullYear()}-${p(due.getMonth() + 1)}-${p(due.getDate())}`;
}

// Have we already sent this exact alert? If not, record it and return true.
// A database error now fails the run loudly. It used to read as "already sent",
// which silently dropped alerts.
async function _claimOnce(key) {
  const rows = await sql(
    'INSERT INTO wf_notified_log(notif_key,sent_at) VALUES($1,$2) ON CONFLICT (notif_key) DO NOTHING RETURNING notif_key',
    [key, Date.now()]
  );
  return rows.length > 0;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).send('');

  // Vercel's own cron scheduler (if you also use vercel.json) sends
  // CRON_SECRET as "Authorization: Bearer <secret>" automatically. The
  // "?secret=" query param is for an external pinger that can't set custom
  // headers on its free tier (e.g. cron-job.org).
  const authHeader = req.headers['authorization'] || '';
  const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const secret = req.query.secret || bearerSecret || '';
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const results = { morningRan: false, managerDigests: 0, workerContractAlerts: 0, shiftAlerts: 0 };

  try {
    const { dateStr: today, hh, mm } = _romeNow();

    // ── 1) Morning batch — this is the manager's ONLY recurring push
    // (login-issue alerts are the other source, but those only fire when
    // something actually goes wrong at sign-in, so most days this is the
    // sole manager notification). It used to require the EXACT 07:00 Rome
    // hour, which silently depended on a pinger landing a request inside
    // that one-hour window every single day. Two real gaps made that
    // fragile: Vercel's own backup cron (vercel.json) runs on a fixed UTC
    // time, which drifts an hour relative to Rome time across the
    // daylight-saving change, and the external cron-job.org pinger's
    // schedule only covered 15:00-23:59 Rome (the shift-check window),
    // never touching the morning hour at all. Result: the morning digest
    // could go days/weeks without ever actually firing, even though the
    // code itself was correct. Widened to a 3-hour window (still
    // once-per-day thanks to the date-keyed dedup below) so any
    // reasonably-configured pinger has a much easier time landing inside
    // it. Pair this with widening the cron-job.org schedule to also ping
    // during early morning Rome time — see NOTIFICATIONS-SETUP.md.
    if (hh >= 6 && hh <= 8) {
      const claimedMorning = await _claimOnce(`morning:${today}`);
      if (claimedMorning) {
        results.morningRan = true;

        // The cron can fire before anyone has opened the new version of the
        // app, which is what normally adds this column. Once a day, free.
        await sql('ALTER TABLE wf_users ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false');
        // One-shot keys are useless after their day has passed. Expiry keys
        // are kept, or a long-expired contract would alert all over again.
        await sql("DELETE FROM wf_notified_log WHERE sent_at<$1 AND (notif_key LIKE 'shiftend:%' OR notif_key LIKE 'morning:%')", [Date.now() - 90 * 86400000]);

        const cfgRows = await sql('SELECT notify_window FROM wf_config WHERE id=1 LIMIT 1');
        const windowDays = Number(cfgRows[0]?.notify_window) || 10;

        const workers = await sql("SELECT username,label,doc_expiry,permit_expiry,idoneita_expiry,patente_expiry,contract_expiry FROM wf_users WHERE role='worker' AND COALESCE(archived,false)=false");
        const vehicles = await sql('SELECT id,plate,model,inspection_date,insurance_expiry,road_tax_expiry FROM wf_vehicles');
        const properties = await sql('SELECT id,name,contract_end,rent_day FROM wf_properties');
        const managers = await sql("SELECT username FROM wf_users WHERE role='manager'");

        // Full expiry sweep (all fields) — for the manager digest count only.
        let managerItemCount = 0;
        const bump = (iso) => {
          const d = _daysUntil(iso, today);
          if (d !== null && d <= windowDays) managerItemCount++;
        };
        workers.forEach(u => {
          bump(u.doc_expiry); bump(u.permit_expiry); bump(u.idoneita_expiry);
          bump(u.patente_expiry); bump(u.contract_expiry);
        });
        vehicles.forEach(v => { bump(v.inspection_date); bump(v.insurance_expiry); bump(v.road_tax_expiry); });
        properties.forEach(p => {
          bump(p.contract_end);
          const due = _nextRentDue(p.rent_day, today);
          if (due) bump(due);
        });

        if (managerItemCount > 0) {
          await Promise.all(managers.map(m => sendPushToUser(m.username, {
            title: 'Newidra — Notifiche / إشعارات',
            body: `${managerItemCount} elemento/i in scadenza — controlla le notifiche / ${managerItemCount} عنصر يقترب من الانتهاء`,
            url: '/?source=push&view=notifications',
            tag: 'morning-digest',
          })));
          results.managerDigests = managers.length;
        }

        // Worker's own contract only — sent to the worker, not the manager.
        for (const u of workers) {
          const d = _daysUntil(u.contract_expiry, today);
          if (d === null || d > windowDays) continue;
          const key = `contract:${u.username}:${u.contract_expiry}`;
          const isNew = await _claimOnce(key);
          if (!isNew) continue;
          const body = d < 0
            ? `Il tuo contratto è scaduto / انتهى عقدك`
            : d === 0
              ? `Il tuo contratto scade oggi / ينتهي عقدك اليوم`
              : `Il tuo contratto scade tra ${d} giorni / ينتهي عقدك خلال ${d} أيام`;
          await sendPushToUser(u.username, {
            title: 'Newidra — Contratto / العقد',
            body,
            url: '/?source=push',
            tag: key,
          });
          results.workerContractAlerts++;
        }
      }
    }

    // ── 2) Shift-ending check — only between 15:00 and 23:59 Rome time ─
    // Your sites end somewhere between 16:00 and midnight, on the hour or
    // the half-hour — this window gives a 1-hour buffer before the
    // earliest one and covers straight through to midnight. Outside this
    // window the check is skipped entirely — no shifts could plausibly be
    // ending, so there's nothing to look for. Paired with a pinger that
    // hits this endpoint at :20 and :50 past each hour in this range, so
    // both on-the-hour and half-hour end times get caught within 10
    // minutes of ending either way.
    const SHIFT_CHECK_START_HOUR = 15;
    const SHIFT_CHECK_END_HOUR = 23;
    if (hh >= SHIFT_CHECK_START_HOUR && hh <= SHIFT_CHECK_END_HOUR) {
    const workingShifts = await sql(
      "SELECT id,worker,location_name,location_id FROM wf_shifts WHERE status='working' AND date=$1",
      [today]
    );
    if (workingShifts.length) {
      const [globalCfg] = await sql('SELECT auto_end_time FROM wf_config WHERE id=1 LIMIT 1');
      const globalAutoEnd = globalCfg?.auto_end_time || null;
      const locIds = [...new Set(workingShifts.map(s => s.location_id).filter(Boolean))];
      const locs = locIds.length
        ? await sql(`SELECT id,end_time FROM wf_locations WHERE id = ANY($1)`, [locIds])
        : [];
      const locEndById = Object.fromEntries(locs.map(l => [l.id, l.end_time]));
      const nowMinutes = hh * 60 + mm;

      for (const s of workingShifts) {
        const autoEnd = (s.location_id && locEndById[s.location_id]) || globalAutoEnd;
        if (!autoEnd) continue;
        const [eh, em] = String(autoEnd).split(':').map(Number);
        if (isNaN(eh) || isNaN(em)) continue;
        let endMinutes = eh * 60 + em;
        // A site ending at "00:00" (midnight) is stored as hour 0 — which,
        // read literally, is earlier in the day than "23:50 now", not
        // later. Since we only ever run this check in the afternoon/
        // evening (15:00-23:59), any end time that looks like early
        // morning (before noon) really means "midnight tonight", so treat
        // it as 24:00 for the purposes of this comparison.
        if (endMinutes < 12 * 60) endMinutes += 24 * 60;
        const diff = endMinutes - nowMinutes;
        // Catch window: up to 10 min BEFORE the end time, or up to 20 min
        // AFTER it. The pinger is only scheduled to land inside the "before"
        // half (checks at :20/:50 vs on-the-hour/half-hour end times), but
        // free external cron services (cron-job.org included) don't
        // guarantee second-perfect timing — a run that fires a minute or two
        // early would see diff > 10 and skip entirely, then the next run
        // 30 min later would see diff already very negative and skip again,
        // silently dropping the alert for that shift. Widening the back end
        // of the window means a late-firing or delayed run still catches it
        // and sends a (slightly late, but sent) reminder instead of nothing.
        if (diff <= 10 && diff >= -20) {
          const key = `shiftend:${s.id}`;
          const isNew = await _claimOnce(key);
          if (!isNew) continue;
          const label = diff > 0
            ? `Il tuo turno termina tra ${diff} min${s.location_name ? ' — ' + s.location_name : ''} / ينتهي دوامك خلال ${diff} دقيقة${s.location_name ? ' — ' + s.location_name : ''}`
            : `Il tuo turno dovrebbe essere terminato${s.location_name ? ' — ' + s.location_name : ''} / كان يجب أن ينتهي دوامك الآن${s.location_name ? ' — ' + s.location_name : ''}`;
          const pushResult = await sendPushToUser(s.worker, {
            title: 'Newidra — Turno / الدوام',
            body: label,
            url: '/?source=push',
            tag: key,
          });
          // sendPushToUser never throws, so without this the response would
          // report an alert as "sent" even when the worker has zero
          // registered subscriptions or VAPID keys are missing — this makes
          // that failure visible in the JSON response and Vercel logs
          // instead of looking identical to a real send.
          if (!pushResult.sent) {
            console.warn('[check-notifications] shift alert not delivered', { worker: s.worker, shiftId: s.id, reason: pushResult.reason || 'no active subscriptions', total: pushResult.total });
          }
          results.shiftAlerts++;
          results.shiftAlertsDelivered = (results.shiftAlertsDelivered || 0) + (pushResult.sent || 0);
        }
      }
    }
    } // end SHIFT_CHECK_START_HOUR/SHIFT_CHECK_END_HOUR window

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    console.error('check-notifications failed', e);
    return res.status(500).json({ ok: false, error: e?.message || String(e), ...results });
  }
}
