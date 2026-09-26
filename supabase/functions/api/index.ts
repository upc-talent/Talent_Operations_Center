// ════════════════════════════════════════════════════════════════════
// Talent Operations Center — Supabase Edge Function "api"
// --------------------------------------------------------------------
// The single backend: every read, every write and all authentication go through here.
// The front-end talks to it through one thin layer — see assets/js/api.js / config.js.
//
// Auth (unchanged model): trainer actions need a signed, expiring token issued after
// TRAINER_USER/TRAINER_PASS match; supervisor actions are scoped server-side to that
// supervisor's own pharmacists. The database is private (RLS deny-all to the anon key);
// only this function touches it, using the service_role's direct DB connection.
//
// Secrets to set (Dashboard → Edge Functions → Manage secrets, or `supabase secrets set`):
//   TRAINER_USER   the trainer-page username
//   TRAINER_PASS   the trainer-page password
//   TOKEN_SECRET   any long random string (used to sign tokens). Optional — if unset,
//                  one is generated and stored in kv_cache on first use.
// SUPABASE_DB_URL is provided automatically by Supabase.
// ════════════════════════════════════════════════════════════════════
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const DB_URL = Deno.env.get("DB_URL") || Deno.env.get("SUPABASE_DB_URL") || "";
// One pooled client, reused across invocations. prepare:false keeps it compatible with the transaction pooler;
// a small pool + short idle timeout suit short-lived edge isolates (a big pool just holds server slots open).
const sql = postgres(DB_URL, { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10 });

const CONFIG = {
  TOKEN_TTL_HOURS: 10,
  MAX_LOGIN_FAILS: 8,
  LOCKOUT_MINUTES: 10,
  DEFAULT_CAPACITY: 30,
};
const LEAVE_STATUSES = ["Sick Leave", "Annual Leave", "Resignation", "Promotion"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ─────────── helpers ─────────── */
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
const nowIso = () => new Date().toISOString();
const jb = (v: unknown) => (v == null ? null : sql.json(v as any)); // jsonb literal or null

/* ─────────── entry ─────────── */
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  let out: any;
  try {
    const req = await request.json();
    out = await route(req);
  } catch (err) {
    out = { ok: false, error: String((err && (err as Error).message) || err) };
  }
  // Server-side execution time, so a slow day can be told apart from a slow network (the client logs it too).
  if (out && typeof out === "object") out._ms = Date.now() - t0;
  return json(out);
});

async function route(req: any) {
  const action = req.action;
  if (action === "login") return await login(req);
  if (action === "supervisors") return { ok: true, names: await supervisorNames() };
  if (action === "get" && req.key === "company-logo") {
    return { ok: true, data: { records: [], settings: { logo: (await settingsMap()).logo ?? null } } };
  }
  const ctx = await authenticate(req);
  switch (action) {
    case "me": return { ok: true, role: ctx.role, who: ctx.who || null };
    case "get": return { ok: true, data: await getKey(ctx, req.key) };
    case "getMany": return { ok: true, data: await getMany(ctx, req.keys) };
    case "patch": return await patchKey(ctx, req);
    case "venues": requireTrainer(ctx); return { ok: true, venues: await venues() };
  }
  throw new Error("Unknown action");
}

/* ═════════ Auth ═════════ */
type Ctx = { role: "trainer" | "supervisor"; who?: string; user?: string };
function requireTrainer(ctx: Ctx) {
  if (ctx.role !== "trainer") throw new Error("Trainer login required.");
}
async function authenticate(req: any): Promise<Ctx> {
  if (req.token) {
    const p = await verifyToken(req.token);
    if (!p) throw new Error("Session expired — please sign in again.");
    return { role: "trainer", user: p.u };
  }
  if (req.supervisor) {
    // Indexed existence check instead of pulling the whole distinct-supervisor list on every request.
    // Equivalent to "is this one of the names supervisorNames() would return".
    const name = String(req.supervisor);
    if (!name || name === "-" || name === "—") throw new Error("Unknown supervisor.");
    const hit = await sql`select 1 from pharmacists where supervisor = ${name} limit 1`;
    if (!hit.length) throw new Error("Unknown supervisor.");
    return { role: "supervisor", who: name };
  }
  throw new Error("Not authorised.");
}

const encoder = new TextEncoder();
function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function safeEq(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function getSecret(): Promise<string> {
  const env = Deno.env.get("TOKEN_SECRET");
  if (env) return env;
  const hit = await kvGet("token_secret");
  if (hit) return hit;
  const gen = crypto.randomUUID() + crypto.randomUUID();
  await kvPut("token_secret", gen, 100 * 365 * 24 * 3600);
  return gen;
}
async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(await getSecret()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return b64urlFromBytes(new Uint8Array(sig));
}
async function makeToken(user: string): Promise<string> {
  const exp = Date.now() + CONFIG.TOKEN_TTL_HOURS * 3600 * 1000;
  const payload = b64urlFromBytes(encoder.encode(JSON.stringify({ u: user, e: exp })));
  return payload + "." + (await sign(payload));
}
async function verifyToken(tok: unknown): Promise<{ u: string; e: number } | null> {
  if (!tok || typeof tok !== "string") return null;
  const parts = tok.split(".");
  if (parts.length !== 2) return null;
  if (!safeEq(await sign(parts[0]), parts[1])) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (!p || !p.e || Date.now() > p.e) return null;
    return p;
  } catch { return null; }
}

async function login(req: any) {
  const user = Deno.env.get("TRAINER_USER");
  const pass = Deno.env.get("TRAINER_PASS");
  if (!user || !pass) throw new Error("Trainer credentials are not configured on the server (Edge Function secrets).");
  const fails = Number((await kvGet("login_fails")) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS) throw new Error("Too many failed attempts. Please try again in a few minutes.");
  const ok = safeEq(String(req.username || ""), user) && safeEq(String(req.password || ""), pass);
  if (!ok) {
    await kvPut("login_fails", String(fails + 1), CONFIG.LOCKOUT_MINUTES * 60);
    await new Promise((r) => setTimeout(r, 1000));
    throw new Error("Invalid username or password.");
  }
  await kvRemove("login_fails");
  return { ok: true, token: await makeToken(user), ttlHours: CONFIG.TOKEN_TTL_HOURS };
}

/* ═════════ kv_cache (replaces CacheService) ═════════ */
async function kvGet(key: string): Promise<string | null> {
  const rows = await sql`select value, expires_at from kv_cache where key = ${key}`;
  if (!rows.length) return null;
  if (rows[0].expires_at && new Date(rows[0].expires_at).getTime() < Date.now()) {
    await sql`delete from kv_cache where key = ${key}`;
    return null;
  }
  return rows[0].value;
}
async function kvPut(key: string, value: string, ttlSeconds: number) {
  const exp = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await sql`insert into kv_cache (key, value, expires_at) values (${key}, ${value}, ${exp})
            on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
}
async function kvRemove(key: string) {
  await sql`delete from kv_cache where key = ${key}`;
}

/* ═════════ Settings ═════════ */
async function settingsMap(): Promise<Record<string, any>> {
  const rows = await sql`select key, value from settings`;
  const out: Record<string, any> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function patchSettings(patch: Record<string, any>) {
  for (const k of Object.keys(patch)) {
    const v = patch[k] === undefined ? null : patch[k];
    await sql`insert into settings (key, value) values (${k}, ${jb(v)})
              on conflict (key) do update set value = excluded.value`;
  }
}

/* ═════════ Supervisors / Venues ═════════ */
async function supervisorNames(): Promise<string[]> {
  const rows = await sql`select distinct supervisor from pharmacists
                         where supervisor <> '' and supervisor <> '-' and supervisor <> '—'
                         order by supervisor`;
  return rows.map((r: any) => r.supervisor);
}
async function venues() {
  const rows = await sql`select city, venue from venues where city <> '' and venue <> '' order by city`;
  return rows.map((r: any) => ({ city: r.city, venue: r.venue }));
}

/* ═════════ Dates & attendance helpers (must match the labels in assets/js/common.js) ═════════ */
function parseIso(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}
function fmtDate(iso: string) {
  const p = parseIso(iso);
  if (!p) return String(iso || "");
  return p.d + " " + MONTHS[p.m] + " " + String(p.y).slice(-2);
}
function isSplit(day: any) { return !!(day && day.isOnline && day.onlineFormat === "split"); }
function dayLabel(day: any) {
  if (!day || !day.date) return "";
  if (!isSplit(day)) return fmtDate(day.date);
  const p = parseIso(day.date);
  if (!p) return fmtDate(day.date);
  const dt = new Date(Date.UTC(p.y, p.m, p.d + 1));
  const m2 = dt.getUTCMonth(), d2 = dt.getUTCDate(), yy = String(p.y).slice(-2);
  if (p.m === m2) return p.d + " - " + d2 + " " + MONTHS[p.m] + " " + yy;
  return p.d + " " + MONTHS[p.m] + " - " + d2 + " " + MONTHS[m2] + " " + yy;
}

/* ═════════ READ ═════════ */
async function getMany(ctx: Ctx, keys: string[]) {
  if (!keys || !keys.length) throw new Error("No keys requested.");
  if (keys.length > 12) throw new Error("Too many keys.");
  const out: Record<string, any> = {};
  for (const k of keys) out[k] = await getKey(ctx, k);
  return out;
}
async function getKey(ctx: Ctx, key: string) {
  switch (key) {
    case "master-pharmacists": return await getMaster(ctx);
    case "operations": return await getOps(ctx);
    case "training-config": return await getConfig(ctx);
    case "company-logo": return { records: [], settings: { logo: (await settingsMap()).logo ?? null } };
    case "pending-pharmacists":
    case "leave-requests":
    case "quota-approval-history":
    case "pharmacist-notifications": return await getTable(ctx, key);
  }
  throw new Error("Unknown data key.");
}

function masterOf(r: any) {
  const m: any = {
    id: r.id, district: r.district, areaManager: r.area_manager, city: r.city,
    supervisor: r.supervisor, pharmacyNo: r.pharmacy_no, employeeId: r.employee_id, email: r.email,
    displayName: r.display_name, phone: r.phone, scfhs: r.scfhs, note: r.note,
  };
  if (r.completion_pct !== null && r.completion_pct !== undefined && r.completion_pct !== "") m.completionPct = r.completion_pct;
  return m;
}
// Only the columns the caller actually receives are read — and a supervisor's rows are filtered in SQL rather
// than fetching the whole roster and discarding it. (Supervisors deliberately never get phone/licence details.)
async function getMaster(ctx: Ctx) {
  if (ctx.role === "supervisor") {
    const rows = await sql`select id, district, area_manager, city, supervisor, email, display_name, note, completion_pct
                           from pharmacists where display_name <> '' and supervisor = ${ctx.who} order by created_at`;
    return { records: rows.map((r: any) => {
      const m: any = { id: r.id, district: r.district, areaManager: r.area_manager, city: r.city,
        supervisor: r.supervisor, email: r.email, displayName: r.display_name, note: r.note };
      if (r.completion_pct !== null && r.completion_pct !== undefined && r.completion_pct !== "") m.completionPct = r.completion_pct;
      return { id: m.id, v: m };
    }), settings: {} };
  }
  const rows = await sql`select id, district, area_manager, city, supervisor, pharmacy_no, employee_id, email,
                                display_name, phone, scfhs, note, completion_pct
                         from pharmacists where display_name <> '' order by created_at`;
  return { records: rows.map((r: any) => ({ id: r.id, v: masterOf(r) })), settings: {} };
}
async function getOps(ctx: Ctx) {
  const rows = await sql`select id, supervisor, assignment, attendance from pharmacists
                         where assignment is not null or attendance is not null`;
  const recs: any[] = [];
  for (const r of rows) {
    const a = r.assignment, t = r.attendance;
    if (!a && !t) continue;
    if (ctx.role === "supervisor" && r.supervisor !== ctx.who) {
      if (a && a.type === "date") recs.push({ id: r.id, v: { a: { type: "date", dateId: a.dateId } } });
      continue;
    }
    recs.push({ id: r.id, v: { a, t } });
  }
  return { records: recs, settings: {} };
}
async function daysList() {
  const rows = await sql`select id, data from training_days`;
  return rows.map((r: any) => ({ id: r.id, v: r.data }));
}
async function daysMap() {
  const rows = await sql`select id, data from training_days`;
  const map: Record<string, any> = {};
  for (const r of rows) map[r.id] = r.data;
  return map;
}
async function getConfig(ctx: Ctx) {
  let days = await daysList();
  const st = await settingsMap();
  let settings: Record<string, any> = {};
  ["maxCapacity", "trainerNames", "coordinatorNames", "trainingNames", "completionCourse", "completionLastSynced"].forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(st, k) && st[k] !== null) settings[k] = st[k];
  });
  if (ctx.role === "supervisor") {
    settings = { maxCapacity: settings.maxCapacity };
    days = days.map((x: any) => {
      const d = x.v || {};
      const q: any = {};
      if (d.supervisorQuotas && Object.prototype.hasOwnProperty.call(d.supervisorQuotas, ctx.who!)) q[ctx.who!] = d.supervisorQuotas[ctx.who!];
      const copy: any = {};
      Object.keys(d).forEach((k) => { copy[k] = d[k]; });
      copy.supervisorQuotas = q;
      delete copy.zoomLink;
      return { id: x.id, v: copy };
    });
  }
  return { records: days, settings };
}

const APPROVAL_TYPE: Record<string, string> = {
  "pending-pharmacists": "New Pharmacist",
  "leave-requests": "Annual Leave",
  "quota-approval-history": "Over-Quota Decision",
};
function approvalFromRow(r: any) {
  const obj = (r.data && typeof r.data === "object") ? { ...r.data } : { id: r.id };
  obj.id = r.id;
  if (r.status) obj.status = r.status;
  obj.rejectionReason = r.reason || obj.rejectionReason || "";
  return obj;
}
function notifFromRow(r: any) {
  return { id: r.id, supervisor: r.supervisor, pharmacistName: r.pharmacist_name, result: r.result, reason: r.reason, decidedAt: r.decided_at, read: r.read, seenInHistory: r.seen_in_history };
}
async function getTable(ctx: Ctx, key: string) {
  const sup = ctx.role === "supervisor" ? ctx.who : null;   // scope in SQL, not after the fact
  let list: any[];
  if (key === "pharmacist-notifications") {
    const rows = sup
      ? await sql`select * from notifications where supervisor = ${sup}`
      : await sql`select * from notifications`;
    list = rows.map(notifFromRow);
  } else {
    const type = APPROVAL_TYPE[key];
    const rows = sup
      ? await sql`select * from approvals where type = ${type} and supervisor = ${sup}`
      : await sql`select * from approvals where type = ${type}`;
    list = rows.map(approvalFromRow);
  }
  return { records: list.map((v) => ({ id: v.id, v })), settings: {} };
}

/* ═════════ WRITE ═════════ */
async function patchKey(ctx: Ctx, req: any) {
  const key = req.key;
  const records = req.records || {};
  const settings = req.settings || {};
  switch (key) {
    case "operations": await patchOps(ctx, records); break;
    case "master-pharmacists": requireTrainer(ctx); await patchMaster(records); break;
    case "training-config": requireTrainer(ctx); await patchConfig(records, settings); break;
    case "company-logo": requireTrainer(ctx); await patchSettings({ logo: settings.logo === undefined ? null : settings.logo }); break;
    case "pending-pharmacists":
    case "leave-requests":
    case "pharmacist-notifications": await patchTableGuarded(ctx, key, records); break;
    case "quota-approval-history": requireTrainer(ctx); await patchApprovals(key, records); break;
    default: throw new Error("Unknown data key.");
  }
  return { ok: true };
}

/* ---------- master roster (trainer only) ----------
   One transaction, a few set-based statements: a roster upload of ~1,500 people is all-or-nothing (a failure can't
   leave half the old list next to half the new one, i.e. duplicates) and takes 3 round trips instead of ~3,000. */
async function patchMaster(records: Record<string, any>) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const del = ids.filter((id) => records[id] === null);
  const upserts = ids.filter((id) => records[id] !== null);
  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const cols = (list: string[]) => {
    const pick = (f: (m: any) => unknown) => list.map((id) => f(records[id]));
    return {
      district: pick((m) => s(m.district)), area: pick((m) => s(m.areaManager)), city: pick((m) => s(m.city)),
      sup: pick((m) => s(m.supervisor)), pharmacy: pick((m) => s(m.pharmacyNo)), emp: pick((m) => s(m.employeeId)),
      email: pick((m) => s(m.email)), name: pick((m) => s(m.displayName)), phone: pick((m) => s(m.phone)),
      scfhs: pick((m) => s(m.scfhs)), note: pick((m) => s(m.note)),
      noteSet: pick((m) => (m.note !== undefined ? "1" : "0")),   // a note is only written when the caller sent one
      completion: pick((m) => (m.completionPct === undefined || m.completionPct === null) ? null : String(m.completionPct)),
    };
  };
  await sql.begin(async (tx: any) => {
    if (del.length) await tx`delete from pharmacists where id = any(${del}::text[])`;
    if (!upserts.length) return;
    const existing = new Set((await tx`select id from pharmacists where id = any(${upserts}::text[])`).map((r: any) => r.id));
    const upd = upserts.filter((id) => existing.has(id));
    const ins = upserts.filter((id) => !existing.has(id));
    if (upd.length) {
      // Master fields only — assignment/attendance are never touched here.
      const c = cols(upd);
      await tx`update pharmacists p set
          district = d.district, area_manager = d.area, city = d.city, supervisor = d.sup, pharmacy_no = d.pharmacy,
          employee_id = d.emp, email = d.email, display_name = d.name, phone = d.phone, scfhs = d.scfhs,
          completion_pct = d.completion, note = case when d.note_set = '1' then d.note else p.note end
        from (select unnest(${upd}::text[]) as id, unnest(${c.district}::text[]) as district, unnest(${c.area}::text[]) as area,
                     unnest(${c.city}::text[]) as city, unnest(${c.sup}::text[]) as sup, unnest(${c.pharmacy}::text[]) as pharmacy,
                     unnest(${c.emp}::text[]) as emp, unnest(${c.email}::text[]) as email, unnest(${c.name}::text[]) as name,
                     unnest(${c.phone}::text[]) as phone, unnest(${c.scfhs}::text[]) as scfhs, unnest(${c.note}::text[]) as note,
                     unnest(${c.noteSet}::text[]) as note_set, unnest(${c.completion}::text[]) as completion) d
        where p.id = d.id`;
    }
    if (ins.length) {
      const c = cols(ins);
      await tx`insert into pharmacists
          (id, district, area_manager, city, supervisor, pharmacy_no, employee_id, email, display_name, phone, scfhs, note, completion_pct)
        select * from unnest(${ins}::text[], ${c.district}::text[], ${c.area}::text[], ${c.city}::text[], ${c.sup}::text[],
                             ${c.pharmacy}::text[], ${c.emp}::text[], ${c.email}::text[], ${c.name}::text[], ${c.phone}::text[],
                             ${c.scfhs}::text[], ${c.note}::text[], ${c.completion}::text[])`;
    }
  });
}

/* ---------- assignments & attendance ---------- */
async function patchOps(ctx: Ctx, records: Record<string, any>) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const isSup = ctx.role === "supervisor";
  // Does this write actually move anyone between days? Marking attendance doesn't, and that's the common case.
  const changesAssignment = ids.some((id) => Object.prototype.hasOwnProperty.call(records[id] || {}, "a"));
  // Training days and the capacity default are ONLY needed to validate a supervisor's assignment.
  let days: Record<string, any> = {};
  let defaultCap = CONFIG.DEFAULT_CAPACITY;
  if (isSup && changesAssignment) {
    days = await daysMap();
    defaultCap = Number((await settingsMap()).maxCapacity) || CONFIG.DEFAULT_CAPACITY;
  }

  await sql.begin(async (tx: any) => {
    // Serialize only writes that change seat occupancy (the old script lock serialized everything). Attendance-only
    // writes can't overbook a day, so they don't queue behind each other.
    if (changesAssignment) await tx`select pg_advisory_xact_lock(911)`;

    // Read ONLY the rows being changed, instead of the whole roster.
    const rows = await tx`select id, supervisor, city, assignment, attendance from pharmacists where id in ${tx(ids)}`;
    const byId: Record<string, any> = {};
    for (const r of rows) byId[r.id] = r;

    // Seat counts, computed by the database and only for the days this write touches (current day + requested day).
    const counts: Record<string, number> = {};
    const supCounts: Record<string, Record<string, number>> = {};
    if (isSup && changesAssignment) {
      const dayIds = new Set<string>();
      for (const id of ids) {
        const cur = byId[id]?.assignment;
        if (cur && cur.type === "date") dayIds.add(cur.dateId);
        const na = (records[id] || {}).a;
        if (na && na.type === "date") dayIds.add(na.dateId);
      }
      if (dayIds.size) {
        const agg = await tx`select assignment->>'dateId' as day_id, supervisor, count(*)::int as n
                             from pharmacists
                             where assignment->>'dateId' = any(${[...dayIds]}::text[])
                             group by 1, 2`;
        for (const r of agg) {
          counts[r.day_id] = (counts[r.day_id] || 0) + r.n;
          (supCounts[r.day_id] ||= {})[r.supervisor] = r.n;
        }
      }
    }
    const bump = (a: any, sup: string, delta: number) => {
      if (a && a.type === "date") {
        counts[a.dateId] = (counts[a.dateId] || 0) + delta;
        (supCounts[a.dateId] ||= {})[sup] = (supCounts[a.dateId]?.[sup] || 0) + delta;
      }
    };

    const updates: { id: string; a: any; t: any }[] = [];
    for (const id of ids) {
      const row = byId[id];
      if (!row) continue;
      const rec = records[id] || {};
      const curA = row.assignment, curT = row.attendance;
      let a = Object.prototype.hasOwnProperty.call(rec, "a") ? rec.a : curA;
      const t = Object.prototype.hasOwnProperty.call(rec, "t") ? rec.t : curT;
      const sup = row.supervisor;

      if (ctx.role === "supervisor") {
        if (sup !== ctx.who) throw new Error("Not allowed: that pharmacist belongs to another supervisor.");
        if (Object.prototype.hasOwnProperty.call(rec, "t") && rec.t !== null) throw new Error("Only trainers can record attendance.");
        // Once a pharmacist has attended, only the training team may change their assignment (or clear the attendance).
        if (hasAttended(curT) && ((Object.prototype.hasOwnProperty.call(rec, "a") && !sameAssignment(curA, rec.a)) || Object.prototype.hasOwnProperty.call(rec, "t"))) {
          throw new Error("This pharmacist already attended their training — only the training team can change it.");
        }
        if (Object.prototype.hasOwnProperty.call(rec, "a")) {
          bump(curA, sup, -1);
          try {
            a = validateSupervisorAssignment(ctx, row, curA, rec.a, days, counts, supCounts, defaultCap);
          } catch (e) { bump(curA, sup, +1); throw e; }
          bump(a, sup, +1);
        }
      } else if (Object.prototype.hasOwnProperty.call(rec, "a")) {
        bump(curA, sup, -1);
        bump(a, sup, +1);
      }
      updates.push({ id, a, t });
    }

    // One statement for the whole batch — a bulk assign of 50 people is 1 round trip, not 50.
    if (updates.length) {
      const uIds = updates.map((u) => u.id);
      const uA = updates.map((u) => (u.a == null ? null : JSON.stringify(u.a)));
      const uT = updates.map((u) => (u.t == null ? null : JSON.stringify(u.t)));
      await tx`update pharmacists p
               set assignment = d.a::jsonb, attendance = d.t::jsonb
               from (select unnest(${uIds}::text[]) as id,
                            unnest(${uA}::text[]) as a,
                            unnest(${uT}::text[]) as t) d
               where p.id = d.id`;
    }
  });
}

// Fully attended: a single-day status of Attended, or both days of a split online training attended.
function hasAttended(t: any): boolean {
  if (!t || typeof t !== "object") return false;
  if (t.status === "Attended") return true;
  return !!(t.day1 && t.day1.status === "Attended" && t.day2 && t.day2.status === "Attended");
}
function sameAssignment(a: any, b: any): boolean {
  if (!a || !b) return !a && !b;
  if (a.type !== b.type) return false;
  return a.type === "date" ? a.dateId === b.dateId : a.status === b.status;
}

function validateSupervisorAssignment(ctx: Ctx, row: any, oldA: any, newA: any, days: Record<string, any>, counts: Record<string, number>, supCounts: Record<string, Record<string, number>>, defaultCap: number) {
  if (newA === null) return null;
  if (!newA || typeof newA !== "object") throw new Error("Invalid assignment.");
  if (newA.type === "leave") {
    if (LEAVE_STATUSES.indexOf(newA.status) === -1) throw new Error("Invalid status.");
    return { type: "leave", status: newA.status, assignedBy: ctx.who, assignedAt: nowIso() };
  }
  if (newA.type !== "date") throw new Error("Invalid assignment type.");
  const day = days[newA.dateId];
  if (!day) throw new Error("That training day no longer exists.");
  const sameDay = oldA && oldA.type === "date" && oldA.dateId === newA.dateId;
  if (!sameDay) {
    if (day.active === false) throw new Error("That training day is not open.");
    if ((day.visibleSupervisors || []).indexOf(ctx.who) === -1) throw new Error("That training day is not available to you.");
    const pharmacistOnline = String(row.city).trim().toLowerCase() === "online";
    if (pharmacistOnline !== !!day.isOnline) throw new Error("Online pharmacists can only join online days (and vice versa).");
    if (day.deadline) {
      const dl = Date.parse(day.deadline);
      if (!isNaN(dl) && Date.now() > dl) throw new Error("The deadline for that training day has passed.");
    }
    const cap = day.capacity > 0 ? Number(day.capacity) : defaultCap;
    if ((counts[newA.dateId] || 0) >= cap) throw new Error("That training day is full (" + cap + ").");
  }
  const out: any = { type: "date", dateId: newA.dateId, assignedBy: ctx.who, assignedAt: sameDay && oldA.assignedAt ? oldA.assignedAt : nowIso(), overQuota: false, quotaApproved: true };
  // Per-supervisor quotas apply to in-person days as well as online ones.
  if (day.supervisorQuotas && Object.prototype.hasOwnProperty.call(day.supervisorQuotas, ctx.who!)) {
    if (sameDay && oldA.overQuota) {
      out.overQuota = true; out.quotaApproved = !!oldA.quotaApproved;
    } else {
      const quota = Number(day.supervisorQuotas[ctx.who!]);
      const mine = (supCounts[newA.dateId] && supCounts[newA.dateId][ctx.who!]) || 0;
      if (mine >= quota) { out.overQuota = true; out.quotaApproved = false; }
    }
  }
  return out;
}

/* ---------- training config: days + settings (trainer only) ---------- */
async function patchConfig(records: Record<string, any>, settings: Record<string, any>) {
  for (const id of Object.keys(records)) {
    const d = records[id];
    if (d === null) { await sql`delete from training_days where id = ${id}`; continue; }
    await sql`insert into training_days (id, data, updated_at) values (${id}, ${jb(d)}, now())
              on conflict (id) do update set data = excluded.data, updated_at = now()`;
  }
  if (Object.keys(settings).length) await patchSettings(settings);
}

/* ---------- approvals / notifications ---------- */
function approvalColumns(key: string, obj: any) {
  const base = { supervisor: obj.supervisor || "", pharmacist: obj.displayName || "", reason: obj.rejectionReason || "", data: obj };
  if (key === "pending-pharmacists") return { ...base, type: "New Pharmacist", status: obj.status || "Pending", submitted_at: obj.addedAt || "", decided_at: obj.decidedAt || "" };
  if (key === "leave-requests") return { ...base, type: "Annual Leave", status: obj.status || "Pending", submitted_at: obj.requestedAt || "", decided_at: obj.decidedAt || "" };
  // quota-approval-history
  return { ...base, type: "Over-Quota Decision", status: obj.status || "", submitted_at: "", decided_at: obj.decidedAt || "" };
}
async function patchApprovals(key: string, records: Record<string, any>) {
  for (const id of Object.keys(records)) {
    const v = records[id];
    if (v === null) { await sql`delete from approvals where id = ${id}`; continue; }
    const c = approvalColumns(key, v);
    await sql`insert into approvals (id, type, status, supervisor, pharmacist, submitted_at, decided_at, reason, data)
      values (${id}, ${c.type}, ${c.status}, ${c.supervisor}, ${c.pharmacist}, ${c.submitted_at}, ${c.decided_at}, ${c.reason}, ${jb(c.data)})
      on conflict (id) do update set type = excluded.type, status = excluded.status, supervisor = excluded.supervisor,
        pharmacist = excluded.pharmacist, submitted_at = excluded.submitted_at, decided_at = excluded.decided_at,
        reason = excluded.reason, data = excluded.data`;
  }
}
async function patchNotifications(records: Record<string, any>) {
  for (const id of Object.keys(records)) {
    const n = records[id];
    if (n === null) { await sql`delete from notifications where id = ${id}`; continue; }
    await sql`insert into notifications (id, supervisor, pharmacist_name, result, reason, decided_at, read, seen_in_history)
      values (${id}, ${n.supervisor || ""}, ${n.pharmacistName || ""}, ${n.result || ""}, ${n.reason || ""}, ${n.decidedAt || ""}, ${!!n.read}, ${!!n.seenInHistory})
      on conflict (id) do update set supervisor = excluded.supervisor, pharmacist_name = excluded.pharmacist_name,
        result = excluded.result, reason = excluded.reason, decided_at = excluded.decided_at,
        read = excluded.read, seen_in_history = excluded.seen_in_history`;
  }
}

async function patchTableGuarded(ctx: Ctx, key: string, records: Record<string, any>) {
  if (ctx.role === "trainer") {
    if (key === "pharmacist-notifications") return await patchNotifications(records);
    return await patchApprovals(key, records);
  }
  // supervisor: re-check every change (ownership / status) — never trust what the client sent
  const existing: Record<string, any> = {};
  if (key === "pharmacist-notifications") {
    (await sql`select * from notifications`).forEach((r: any) => { existing[r.id] = notifFromRow(r); });
  } else {
    const type = APPROVAL_TYPE[key];
    (await sql`select * from approvals where type = ${type}`).forEach((r: any) => { existing[r.id] = approvalFromRow(r); });
  }
  const safe: Record<string, any> = {};
  for (const id of Object.keys(records)) {
    const v = records[id], ex = existing[id];
    if (key === "pharmacist-notifications") {
      if (v === null) throw new Error("Not allowed.");
      if (!ex || ex.supervisor !== ctx.who) throw new Error("Not allowed.");
      safe[id] = { id, supervisor: ex.supervisor, pharmacistName: ex.pharmacistName, result: ex.result, reason: ex.reason, decidedAt: ex.decidedAt, read: !!v.read, seenInHistory: !!v.seenInHistory };
      continue;
    }
    if (v === null) {
      if (!ex || ex.supervisor !== ctx.who || ex.status !== "Pending") throw new Error("Only your own pending requests can be removed.");
      safe[id] = null;
      continue;
    }
    if (v.supervisor !== ctx.who) throw new Error("Requests can only be submitted for your own name.");
    if (ex && (ex.supervisor !== ctx.who || ex.status !== "Pending")) throw new Error("This request has already been decided.");
    if (v.status !== "Pending") throw new Error("New requests must start as Pending.");
    safe[id] = v;
  }
  if (key === "pharmacist-notifications") return await patchNotifications(safe);
  return await patchApprovals(key, safe);
}
