// ════════════════════════════════════════════════════════════════════
// Talent Operations Center — Supabase Edge Function "backup"
// --------------------------------------------------------------------
// Hourly safety copy of the database into a Google Sheet. Supabase's scheduler (pg_cron, see
// supabase/backup.sql) calls this function once an hour; it reads every table and WRITES it to the
// Sheet through a Google service account. It never returns data to the caller (only counts), and the
// app itself never talks to the Sheet — it is a one-way backup.
//
// Sheet layout: one tab per table (Pharmacists, Training Days, Approvals, Notifications, Settings,
// Venues), each fully replaced on every run, plus a "Log" tab that gets one new row per run:
// time, status, rows per table, and what changed since the previous backup.
//
// Secrets (Dashboard → Edge Functions → Secrets):
//   BACKUP_SECRET           long random string; the scheduler must send it (x-backup-secret header)
//   BACKUP_SHEET_ID         the Google Sheet's id (the long part of its URL between /d/ and /edit)
//   GOOGLE_SERVICE_ACCOUNT  the whole JSON key file of the Google service account (paste its contents)
// SUPABASE_DB_URL is provided automatically by Supabase.
// ════════════════════════════════════════════════════════════════════
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const DB_URL = Deno.env.get("DB_URL") || Deno.env.get("SUPABASE_DB_URL") || "";
const sql = postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10 });

const STATE_KEY = "backup_state";        // kv_cache row holding a fingerprint of every backed-up row (for the Log)
const MAX_CELL = 49000;                  // Google Sheets refuses cells over 50,000 characters
const MAX_NAMES = 20;                    // names listed per change type in a Log row
const LOG_TAB = "Log";

Deno.serve(async (request) => {
  const secret = Deno.env.get("BACKUP_SECRET") || "";
  const sent = request.headers.get("x-backup-secret") || "";
  if (!secret || !safeEq(sent, secret)) return json({ ok: false, error: "Not authorised." }, 401);
  const t0 = Date.now();
  let summary = "";
  try {
    const sheetId = Deno.env.get("BACKUP_SHEET_ID");
    const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
    if (!sheetId || !saJson) throw new Error("BACKUP_SHEET_ID / GOOGLE_SERVICE_ACCOUNT secrets are not set.");
    const token = await googleToken(JSON.parse(saJson));

    const tables = await readTables();
    const prev = await loadState();
    const { changes, state } = diff(tables, prev);

    await ensureTabs(token, sheetId, [...tables.map((t) => t.tab), LOG_TAB]);
    await writeTables(token, sheetId, tables);

    summary = tables.map((t) => `${t.tab}: ${t.rows.length}`).join(" · ");
    await appendLog(token, sheetId, [stamp(), "OK", summary, changes, ((Date.now() - t0) / 1000).toFixed(1) + " s"]);
    await saveState(state);   // only after the Sheet was written, so a failed run is compared against the last good one
    return json({ ok: true, rows: summary });
  } catch (err) {
    const msg = String((err && (err as Error).message) || err);
    // best effort: record the failure in the Log too
    try {
      const sheetId = Deno.env.get("BACKUP_SHEET_ID"), saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
      if (sheetId && saJson) {
        const token = await googleToken(JSON.parse(saJson));
        await ensureTabs(token, sheetId, [LOG_TAB]);
        await appendLog(token, sheetId, [stamp(), "FAILED", summary, msg.slice(0, 2000), ((Date.now() - t0) / 1000).toFixed(1) + " s"]);
      }
    } catch (_) { /* nothing more we can do */ }
    return json({ ok: false, error: msg }, 500);
  }
});

/* ─────────── helpers ─────────── */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function safeEq(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
// Saudi time for the Log (UTC+3, no daylight saving)
function stamp() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " (KSA)";
}
const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + " …[cut: too long for one cell]" : s;
};
function fingerprint(s: string) {   // FNV-1a — enough to tell "changed" from "unchanged"
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/* ─────────── read everything ─────────── */
type Table = { tab: string; header: string[]; rows: string[][]; ids: string[]; names: string[] };
async function readTables(): Promise<Table[]> {
  const days = await sql`select id, data, updated_at from training_days order by id`;
  const dayText: Record<string, string> = {};
  for (const d of days) { const v = d.data || {}; dayText[d.id] = [v.trainingName || v.city || "", v.date || ""].filter(Boolean).join(" — "); }

  const ph = await sql`select * from pharmacists order by created_at, id`;
  const pharmacists: Table = {
    tab: "Pharmacists",
    header: ["id", "district", "area_manager", "city", "supervisor", "pharmacy_no", "employee_id", "email", "display_name",
      "phone", "scfhs", "note", "completion_pct (Core)", "capsule_pct", "work_shift", "training day (readable)",
      "assignment (json)", "attendance (json)", "created_at"],
    rows: ph.map((r: any) => [r.id, r.district, r.area_manager, r.city, r.supervisor, r.pharmacy_no, r.employee_id, r.email,
      r.display_name, r.phone, r.scfhs, r.note, r.completion_pct, r.capsule_pct, r.work_shift,
      r.assignment ? (r.assignment.type === "date" ? (dayText[r.assignment.dateId] || "(deleted day)") : r.assignment.status) : "",
      r.assignment, r.attendance, r.created_at ? new Date(r.created_at).toISOString() : ""].map(cell)),
    ids: ph.map((r: any) => r.id), names: ph.map((r: any) => r.display_name || r.id),
  };
  const trainingDays: Table = {
    tab: "Training Days",
    header: ["id", "date", "city", "training name", "type", "online", "active", "visible to", "not editable for",
      "capacity", "deadline", "trainers", "data (json)", "updated_at"],
    rows: days.map((r: any) => { const v = r.data || {}; return [r.id, v.date, v.city, v.trainingName, v.type, v.isOnline ? "yes" : "no",
      v.active === false ? "hidden" : "active", (v.visibleSupervisors || []).join(", "), (v.readOnlySupervisors || []).join(", "),
      v.capacity, v.deadline, (v.trainerNames || []).join(", "), v, r.updated_at ? new Date(r.updated_at).toISOString() : ""].map(cell); }),
    ids: days.map((r: any) => r.id), names: days.map((r: any) => dayText[r.id] || r.id),
  };
  const ap = await sql`select * from approvals order by type, id`;
  const approvals: Table = {
    tab: "Approvals",
    header: ["id", "type", "status", "supervisor", "pharmacist", "submitted_at", "decided_at", "reason", "data (json)"],
    rows: ap.map((r: any) => [r.id, r.type, r.status, r.supervisor, r.pharmacist, r.submitted_at, r.decided_at, r.reason, r.data].map(cell)),
    ids: ap.map((r: any) => r.id), names: ap.map((r: any) => `${r.type}: ${r.pharmacist || r.supervisor}`),
  };
  const nt = await sql`select * from notifications order by id`;
  const notifications: Table = {
    tab: "Notifications",
    header: ["id", "supervisor", "pharmacist_name", "result", "reason", "decided_at", "read", "seen_in_history"],
    rows: nt.map((r: any) => [r.id, r.supervisor, r.pharmacist_name, r.result, r.reason, r.decided_at, r.read, r.seen_in_history].map(cell)),
    ids: nt.map((r: any) => r.id), names: nt.map((r: any) => r.pharmacist_name),
  };
  const st = await sql`select key, value from settings order by key`;
  const settings: Table = {
    tab: "Settings", header: ["key", "value (json)"],
    rows: st.map((r: any) => [r.key, r.value].map(cell)), ids: st.map((r: any) => r.key), names: st.map((r: any) => r.key),
  };
  const vn = await sql`select id, city, venue from venues order by id`;
  const venues: Table = {
    tab: "Venues", header: ["id", "city", "venue"],
    rows: vn.map((r: any) => [r.id, r.city, r.venue].map(cell)), ids: vn.map((r: any) => String(r.id)), names: vn.map((r: any) => r.venue),
  };
  // kv_cache is deliberately NOT backed up: it only holds short-lived values and the login-token signing secret.
  return [pharmacists, trainingDays, approvals, notifications, settings, venues];
}

/* ─────────── what changed since the last backup ─────────── */
type State = Record<string, { fp: Record<string, string>; names: Record<string, string> }>;
async function loadState(): Promise<State | null> {
  const r = await sql`select value from kv_cache where key = ${STATE_KEY}`;
  if (!r.length || !r[0].value) return null;
  try { return JSON.parse(r[0].value); } catch { return null; }
}
async function saveState(state: State) {
  await sql`insert into kv_cache (key, value, expires_at) values (${STATE_KEY}, ${JSON.stringify(state)}, null)
            on conflict (key) do update set value = excluded.value, expires_at = null`;
}
function diff(tables: Table[], prev: State | null) {
  const state: State = {};
  const parts: string[] = [];
  for (const t of tables) {
    const fp: Record<string, string> = {}, names: Record<string, string> = {};
    t.ids.forEach((id, i) => { fp[id] = fingerprint(t.rows[i].join("\u0001")); names[id] = t.names[i] || id; });
    state[t.tab] = { fp, names };
    if (!prev) continue;
    const old = prev[t.tab] || { fp: {}, names: {} };
    const added = t.ids.filter((id) => !(id in old.fp));
    const removed = Object.keys(old.fp).filter((id) => !(id in fp));
    const changed = t.ids.filter((id) => id in old.fp && old.fp[id] !== fp[id]);
    if (!added.length && !removed.length && !changed.length) continue;
    const list = (ids: string[], nm: Record<string, string>) =>
      " (" + ids.slice(0, MAX_NAMES).map((id) => nm[id] || id).join(", ") + (ids.length > MAX_NAMES ? `, +${ids.length - MAX_NAMES} more` : "") + ")";
    const bits: string[] = [];
    if (added.length) bits.push(`+${added.length} added${list(added, names)}`);
    if (removed.length) bits.push(`${removed.length} removed${list(removed, old.names)}`);
    if (changed.length) bits.push(`${changed.length} changed${list(changed, names)}`);
    parts.push(`${t.tab}: ${bits.join("; ")}`);
  }
  const changes = !prev ? "First backup" : (parts.length ? parts.join("\n") : "No changes");
  return { changes: cell(changes), state };
}

/* ─────────── Google Sheets (service-account sign-in, then the Sheets REST API) ─────────── */
async function googleToken(sa: { client_email: string; private_key: string }) {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + b64url(sig) }),
  });
  const out = await res.json();
  if (!res.ok || !out.access_token) throw new Error("Google sign-in failed: " + (out.error_description || out.error || res.status));
  return out.access_token as string;
}
function b64url(bytes: Uint8Array) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function gapi(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + url, {
    method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Google Sheets error " + res.status + ": " + ((out.error && out.error.message) || ""));
  return out;
}
const q = (tab: string) => "'" + tab.replace(/'/g, "''") + "'";
async function ensureTabs(token: string, sheetId: string, tabs: string[]) {
  const meta = await gapi(token, "GET", `${sheetId}?fields=sheets.properties.title`);
  const have = new Set((meta.sheets || []).map((s: any) => s.properties.title));
  const missing = tabs.filter((t) => !have.has(t));
  if (!missing.length) return;
  await gapi(token, "POST", `${sheetId}:batchUpdate`, { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) });
  if (missing.includes(LOG_TAB)) {
    await gapi(token, "PUT", `${sheetId}/values/${encodeURIComponent(q(LOG_TAB) + "!A1")}?valueInputOption=RAW`,
      { values: [["Time", "Status", "Rows per table", "Changes since the previous backup", "Duration"]] });
  }
}
// Each table tab is replaced in full: clear it, then write the header row and every row.
async function writeTables(token: string, sheetId: string, tables: Table[]) {
  await gapi(token, "POST", `${sheetId}/values:batchClear`, { ranges: tables.map((t) => q(t.tab)) });
  await gapi(token, "POST", `${sheetId}/values:batchUpdate`, {
    valueInputOption: "RAW",
    data: tables.map((t) => ({ range: q(t.tab) + "!A1", values: [t.header, ...t.rows] })),
  });
}
async function appendLog(token: string, sheetId: string, row: string[]) {
  await gapi(token, "POST", `${sheetId}/values/${encodeURIComponent(q(LOG_TAB) + "!A:E")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [row] });
}