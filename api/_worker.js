// ─────────────────────────────────────────────────────────────
// /api/_worker.js — what a signed-in worker may do through /api/sql.
//
// Workers sign in by phone (see /api/login) and get a session with
// role 'worker'. Their app still sends SQL text, but here it only runs if it
// is one of the exact statements the worker screens send, and only for that
// worker's own rows. Anything else is refused. Shift writes are rebuilt from
// an allow-list of columns and pay is recomputed on the server, so a worker
// can't edit another worker's data or inflate their own hours.
// ─────────────────────────────────────────────────────────────
import { sql } from './_lib.js';

export const USER_COLS = 'username,role,phone,hourly_rate,device_id,label,can_restart,can_restart_date,gps_bypass,worker_status,dob,email,tax_code,residence_permit,doc_expiry,iban,address,start_date,job_title,contract_type,contract_date,contract_expiry,permit_expiry,idoneita_expiry,patente_expiry,courses,photo_url,onboarding,on_loan,on_loan_details,archived,archived_at';
const SHIFT_COLS = 'id,worker,date,start_time,end_time,work_hours,earnings,hourly_rate,location_name,location_id,status,billing_start_time,break_minutes';

export const normPhone = p => String(p || '').replace(/\D/g, '').replace(/^0+/, '');

class Refused extends Error {
  constructor(msg) {
    super(msg);
    this.status = 403;
  }
}

const own = (u) => (p) => p[0] === u;

// Read-only statements, exactly as index.html sends them (whitespace folded).
const READS = new Map([
  ['SELECT id,std_hours,ot_rate,auto_end_time,assign_mode FROM wf_config WHERE id=1 LIMIT 1', () => () => true],
  ['SELECT id,name,lat,lng,map_link,added_at,is_open,end_time,start_time,break_minutes,leader_username,finished FROM wf_locations ORDER BY name ASC, added_at ASC', () => () => true],
  [`SELECT ${USER_COLS} FROM wf_users WHERE username=$1 LIMIT 1`, own],
  [`SELECT ${SHIFT_COLS} FROM wf_shifts WHERE worker=$1 AND date=$2 ORDER BY start_time DESC`, own],
  [`SELECT ${SHIFT_COLS} FROM wf_shifts WHERE worker=$1 AND date >= $2 AND date <= $3 ORDER BY start_time DESC`, own],
  ['SELECT worker_username,loc_id FROM wf_assignments WHERE worker_username = ANY($1)', null],
  ['SELECT loc_id FROM wf_assignments WHERE worker_username = ANY($1)', null],
]);

// Columns a worker may write. can_restart can only be switched off.
const USER_WRITE = { can_restart: v => v === false, can_restart_date: v => v === null };
const SHIFT_WRITE = new Set(['worker', 'date', 'start_time', 'end_time', 'work_hours', 'earnings', 'hourly_rate', 'location_name', 'location_id', 'status', 'billing_start_time', 'break_minutes']);

const UPSERT = /^INSERT INTO (wf_users|wf_shifts)\((username|id),([a-z_,]+)\) VALUES\(\$1,([$\d,]+)\) ON CONFLICT\((username|id)\) DO UPDATE SET (.+)$/;

// Same text dbSetUser / dbSetShift build in index.html for these columns.
function upsertText(table, key, cols) {
  const ph = cols.map((_, i) => `$${i + 2}`).join(',');
  const set = cols.map((c, i) => `${c}=$${i + 2}`).join(',');
  return `INSERT INTO ${table}(${key},${cols.join(',')}) VALUES($1,${ph}) ON CONFLICT(${key}) DO UPDATE SET ${set}`;
}

async function workerNorm(username) {
  const r = await sql('SELECT phone FROM wf_users WHERE username=$1 LIMIT 1', [username]);
  return normPhone(r[0]?.phone);
}

async function writeUser(username, cols, params) {
  if (params[0] !== username) throw new Refused('Not your account');
  cols.forEach((c, i) => {
    if (!USER_WRITE[c] || !USER_WRITE[c](params[i + 1])) throw new Refused('Field not allowed');
  });
  return sql(upsertText('wf_users', 'username', cols), params);
}

const SHIFT_STATUS = new Set(['working', 'completed', 'needs_review']);
const MIN_SHIFT_MS = 10 * 60000;

async function writeShift(username, cols, params) {
  const id = params[0];
  if (typeof id !== 'string' || !id) throw new Refused('Bad shift id');
  const v = {};
  cols.forEach((c, i) => {
    if (!SHIFT_WRITE.has(c)) throw new Refused('Field not allowed');
    v[c] = params[i + 1];
  });
  if ('worker' in v && v.worker !== username) throw new Refused('Not your shift');
  if ('status' in v && !SHIFT_STATUS.has(v.status)) throw new Refused('Bad status');
  // A phone clock running fast can't put times in the future: they are capped
  // at the server's clock. A start more than 36 hours old is refused.
  const now = Date.now();
  for (const k of ['start_time', 'end_time']) {
    if (v[k] != null) v[k] = Math.min(Number(v[k]), now);
  }
  if (v.start_time != null && v.start_time < now - 36 * 3600000) throw new Refused('Bad start time');
  // The pay rate comes from the worker's record and pay is worked out below,
  // never taken from the phone.
  delete v.hourly_rate;
  delete v.earnings;
  delete v.worker;
  const keys = Object.keys(v);
  const vals = keys.map(k => v[k]);

  const [row] = await sql('SELECT worker,status,start_time FROM wf_shifts WHERE id=$1 LIMIT 1', [id]);
  if (!row) {
    // A new shift always starts as a running one.
    if (v.status !== 'working' || !v.start_time || v.end_time != null) throw new Refused('A new shift must be a running one');
    const [u] = await sql('SELECT hourly_rate FROM wf_users WHERE username=$1 LIMIT 1', [username]);
    const insCols = ['id', 'worker', 'hourly_rate', ...keys];
    await sql(`INSERT INTO wf_shifts(${insCols.join(',')}) VALUES(${insCols.map((_, i) => `$${i + 1}`).join(',')})`,
      [id, username, Number(u?.hourly_rate) || 0, ...vals]);
    return [];
  }
  // Only their own shift, and only while it is still running.
  if (row.worker !== username || row.status !== 'working') throw new Refused('Not your running shift');
  // A worker can't end their own shift in its first 10 minutes (a manager can).
  if ((v.status && v.status !== 'working') || v.end_time != null) {
    const end = v.end_time != null ? v.end_time : now;
    if (end - Number(row.start_time) < MIN_SHIFT_MS) throw new Refused('Shift can be ended after 10 minutes');
  }
  if (!keys.length) return [];
  await sql(`UPDATE wf_shifts SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND worker=$2`, [id, username, ...vals]);
  if (!('end_time' in v || 'work_hours' in v)) return [];
  // Paid hours can't be more than the time from paid start to end, and pay is
  // those hours × the rate stored on the shift.
  await sql(`UPDATE wf_shifts SET
      billing_start_time = GREATEST(COALESCE(billing_start_time, start_time), start_time),
      work_hours = CASE WHEN end_time IS NULL OR work_hours IS NULL THEN work_hours
        ELSE ROUND(LEAST(work_hours::numeric, GREATEST(0, end_time - GREATEST(COALESCE(billing_start_time, start_time), start_time)) / 3600000.0), 6) END
    WHERE id=$1 AND worker=$2`, [id, username]);
  await sql('UPDATE wf_shifts SET earnings = CASE WHEN work_hours IS NULL THEN NULL ELSE ROUND(work_hours * COALESCE(hourly_rate,0), 4) END WHERE id=$1 AND worker=$2', [id, username]);
  return [];
}

export async function runWorkerQuery(username, query, params) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  const p = Array.isArray(params) ? params : [];

  if (READS.has(q)) {
    const make = READS.get(q);
    if (make) {
      if (!make(username)(p)) throw new Refused('Not your data');
    } else {
      // Assignments are keyed by phone or by username.
      const keys = p[0];
      const norm = await workerNorm(username);
      if (!Array.isArray(keys) || !keys.length || !keys.every(k => k === username || (norm && k === norm))) throw new Refused('Not your data');
    }
    return sql(q, p);
  }

  const m = UPSERT.exec(q);
  if (m && m[2] === m[5]) {
    const [, table, key, colText] = m;
    const cols = colText.split(',');
    if (q !== upsertText(table, key, cols) || p.length !== cols.length + 1) throw new Refused('Not permitted');
    return table === 'wf_users' ? writeUser(username, cols, p) : writeShift(username, cols, p);
  }

  throw new Refused('Not permitted');
}
