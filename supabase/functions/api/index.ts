// ════════════════════════════════════════════════════════════════════
// Talent Operations Center — Supabase Edge Function "api"
// --------------------------------------------------------------------
// The single backend: every read, every write and all authentication go through here.
// The front-end talks to it through one thin layer — see assets/js/api.js / config.js.
//
// Auth: every staff member has their own account (Admins Dashboard). A signed, expiring token is issued after
// the username + password match an entry of STAFF_ACCOUNTS; supervisor actions are scoped server-side to that
// supervisor's own pharmacists. The database is private (RLS deny-all to the anon key); only this function
// touches it, using the service_role's direct DB connection. Every change (and every sign-in) is written to
// activity_log under the signed-in username — only the superadmin can read it.
//
// Roles: superadmin (everything + Activity Log + Admins Permissions) · trainer · coordinator (the old "admin").
//        From v6 each trainer / coordinator account has permission switches (role defaults + the superadmin's
//        changes, kept in staff_accounts) that every action checks — see "Permissions" below. Admins can change their
//        own password (stored as a PBKDF2 hash in staff_accounts; it replaces the STAFF_ACCOUNTS one), and
//        "Keep me signed in" makes a 6-day token instead of 10 hours.
//
// Secrets to set (Dashboard → Edge Functions → Manage secrets, or `supabase secrets set`):
//   STAFF_ACCOUNTS  JSON: {"UPC_TMD":{"role":"superadmin","hash":"pbkdf2$…"}, "UPC_T1":{"role":"trainer","hash":…}, …}
//                   Passwords are stored ONLY as PBKDF2 hashes — make them with dev/password-hash.html (offline).
//   TOKEN_SECRET    any long random string (used to sign tokens). Optional — if unset,
//                   one is generated and stored in kv_cache on first use.
//   (Transition only: while STAFF_ACCOUNTS is unset, the old TRAINER_USER/TRAINER_PASS sign in as a trainer and
//    ADMIN_USER/ADMIN_PASS as a coordinator. Delete those four secrets once STAFF_ACCOUNTS works.)
// SUPABASE_DB_URL is provided automatically by Supabase.
// ════════════════════════════════════════════════════════════════════
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const DB_URL = Deno.env.get("DB_URL") || Deno.env.get("SUPABASE_DB_URL") || "";
// One pooled client, reused across invocations. prepare:false keeps it compatible with the transaction pooler;
// a small pool + short idle timeout suit short-lived edge isolates (a big pool just holds server slots open).
const sql = postgres(DB_URL, { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10 });

const CONFIG = {
  TOKEN_TTL_HOURS: 10,
  REMEMBER_TTL_HOURS: 144,   // "Keep me signed in" = 6 days
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
    // client IP (first x-forwarded-for hop) — only used to rate-limit the public reports page
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    out = await route(req, ip);
  } catch (err) {
    out = { ok: false, error: String((err && (err as Error).message) || err) };
  }
  // Server-side execution time, so a slow day can be told apart from a slow network (the client logs it too).
  if (out && typeof out === "object") out._ms = Date.now() - t0;
  return json(out);
});

async function route(req: any, ip = "unknown") {
  const action = req.action;
  if (action === "login") return await login(req);
  if (action === "supervisors") return { ok: true, names: await supervisorNames() };
  if (action === "get" && req.key === "company-logo") {
    return { ok: true, data: { records: [], settings: { logo: (await settingsMap()).logo ?? null } } };
  }
  // Public reports page (reports.html, no login): read-only, rate-limited — see the REPORTS section.
  if (action === "reportsPublic") { await publicRateLimit(ip); return await reportsPublic(); }
  if (action === "reportsPublicCourse") { await publicRateLimit(ip); return await reportsPublicCourse(req.slug); }
  const ctx = await authenticate(req);
  switch (action) {
    case "me": return { ok: true, role: ctx.role, who: ctx.who || null, user: ctx.role === "supervisor" ? null : ctx.user,
                        ...(isStaff(ctx) ? { perms: ctx.perms, mustChange: !!ctx.mustChange, remember: !!ctx.remember,
                                             ...(await accountNamesFor(ctx.user || "", ctx.role, await accountRow(ctx.user || ""))) } : {}) };
    case "get": return { ok: true, data: await getKey(ctx, req.key) };
    case "getMany": return { ok: true, data: await getMany(ctx, req.keys) };
    case "patch": return await patchKey(ctx, req);
    case "venues": requirePerm(ctx, "days.view", "days.edit", "calendar.edit"); return { ok: true, venues: await venues() };
    case "submit": return await submitSupervisor(ctx);
    case "ping": return await pingPresence(ctx);
    case "presence": requirePerm(ctx, "presence.view"); return { ok: true, ...(await presence()) };
    case "activity": requireSuperadmin(ctx); return { ok: true, ...(await readActivity(req)) };
    // Accounts (v6): own password; the superadmin's Admins Permissions tab
    case "changePassword": return await changePassword(ctx, req);
    case "adminAccounts": requireSuperadmin(ctx); return { ok: true, accounts: await adminAccounts(), keys: PERM_KEYS };
    case "adminSetPerms": requireSuperadmin(ctx); return { ok: true, ...(await adminSetPerms(ctx, req)) };
    case "adminResetPassword": requireSuperadmin(ctx); await adminResetPassword(ctx, req); return { ok: true };
    case "adminSignOut": requireSuperadmin(ctx); await adminSignOut(ctx, req); return { ok: true };
    case "adminCreateUser": requireSuperadmin(ctx); await adminCreateUser(ctx, req); return { ok: true };
    case "adminSetDisabled": requireSuperadmin(ctx); await adminSetDisabled(ctx, req); return { ok: true };
    case "adminDeleteUser": requireSuperadmin(ctx); await adminDeleteUser(ctx, req); return { ok: true };
    case "adminSetNames": requireSuperadmin(ctx); return { ok: true, ...(await adminSetNames(ctx, req)) };
    // Reports (v5) — Moodle Reports / SAP Reports / Reports Configuration (by default superadmin + coordinators)
    case "coursesList": requirePerm(ctx, "moodle.view", "sap.view", "repconf.view"); return { ok: true, ...(await coursesList()) };
    case "courseSave": requirePerm(ctx, "repconf.edit"); return { ok: true, course: await courseSave(ctx, req.course) };
    case "courseDelete": requirePerm(ctx, "repconf.delete"); await courseDelete(ctx, req.id); return { ok: true };
    case "courseShareRotate": requirePerm(ctx, "repconf.edit"); return { ok: true, shareSlug: await courseShareRotate(ctx, req.id) };
    case "categoryColorsSet": requirePerm(ctx, "repconf.edit"); return { ok: true, categoryColors: await categoryColorsSet(ctx, req.colors) };
    case "courseSlotsSet": requirePerm(ctx, "repconf.slots"); await courseSlotsSet(ctx, req.coreCourseId, req.capsuleCourseId); return { ok: true };
    case "coursePublish": requirePerm(ctx, "moodle.publish"); return { ok: true, ...(await coursePublish(ctx, req)) };
    case "courseExport": requirePerm(ctx, "moodle.view", "repconf.view"); return { ok: true, ...(await courseExport(req.id, req.includeNoData)) };
    case "notInRosterList": requirePerm(ctx, "moodle.view"); return { ok: true, people: await notInRosterList() };
    case "reportHideSet": requirePerm(ctx, "moodle.hide"); return { ok: true, changed: await reportHideSet(ctx, req.emails, req.hidden) };
  }
  throw new Error("Unknown action");
}

/* ═════════ Auth ═════════ */
// "coordinator" is the lower-access training-team login (the old "admin"): Attendance tab, Calendar (view only),
// Master Sheet Preview and Import Completion. "trainer" has everything else; "superadmin" also reads the Activity Log.
type StaffRole = "superadmin" | "trainer" | "coordinator";
type Ctx = { role: StaffRole | "supervisor"; who?: string; user?: string; perms?: Record<string, boolean>; mustChange?: boolean;
             remember?: boolean; sv?: number };
const STAFF_ROLES: StaffRole[] = ["superadmin", "trainer", "coordinator"];
const isStaff = (ctx: Ctx) => ctx.role !== "supervisor";
function requireStaff(ctx: Ctx) {
  if (!isStaff(ctx)) throw new Error("Trainer login required.");
}
function requireSuperadmin(ctx: Ctx) {
  if (ctx.role !== "superadmin") throw new Error("Super admin login required.");
}

/* ═════════ Permissions (v6, "Admins Permissions" tab) ═════════
   Every trainer / coordinator account has switches the superadmin can turn on or off. An account starts from its
   role's defaults (below — the same access as before v6); staff_accounts.perms keeps only the switches that differ.
   The superadmin always has everything. The page hides what is off, and the server refuses it (can / requirePerm). */
const PERM_KEYS = [
  "attend.view", "attend.assign", "attend.mark", "attend.edit", "attend.delete", "attend.merge", "attend.notes", "attend.export",
  "attend.exportFull", "attend.coreCapsule", "attend.unsubmit",
  "days.view", "days.edit",
  "calendar.view", "calendar.edit",
  "approvals.view", "approvals.decide",
  "analytics.view", "analytics.cards", "analytics.master", "analytics.export",
  "setup.view", "setup.master", "setup.settings",
  "moodle.view", "moodle.publish", "moodle.hide",
  "sap.view",
  "repconf.view", "repconf.edit", "repconf.slots", "repconf.delete",
  "presence.view",
];
const REPORT_PERMS = ["moodle.view", "moodle.publish", "moodle.hide", "sap.view", "repconf.view", "repconf.edit", "repconf.slots", "repconf.delete"];
function rolePerms(role: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of PERM_KEYS) out[k] = true;
  if (role === "trainer") {
    for (const k of REPORT_PERMS) out[k] = false;
    out["attend.exportFull"] = false;
  } else if (role === "coordinator") {
    for (const k of ["attend.unsubmit", "days.view", "days.edit", "calendar.edit", "approvals.view", "approvals.decide", "analytics.cards",
      "setup.view", "setup.master", "setup.settings", "repconf.delete", "presence.view"]) out[k] = false;
  }
  return out;
}
function effectivePerms(role: string, overrides: any): Record<string, boolean> {
  const out = rolePerms(role);
  if (role === "superadmin") return out;
  if (overrides && typeof overrides === "object") for (const k of PERM_KEYS) if (typeof overrides[k] === "boolean") out[k] = overrides[k];
  // a tab switched off switches off everything inside it ("attend.mark" needs "attend.view", …)
  for (const k of PERM_KEYS) {
    const view = k.split(".")[0] + ".view";
    if (k !== view && PERM_KEYS.indexOf(view) !== -1 && !out[view]) out[k] = false;
  }
  return out;
}
function can(ctx: Ctx, ...keys: string[]): boolean {
  if (ctx.role === "superadmin") return true;
  if (ctx.role === "supervisor" || !ctx.perms) return false;
  return keys.some((k) => ctx.perms![k] === true);
}
function requirePerm(ctx: Ctx, ...keys: string[]) {
  if (!can(ctx, ...keys)) throw new Error("Not available for this login — ask the super admin (Admins Permissions).");
}

const TOKEN_VERSION = 2;   // tokens from before the named accounts (v1) are refused → everyone signs in once more
// The app-side account row (v6). Missing table (schema.sql not re-run yet) → no row, so everything works as before.
async function accountRow(user: string): Promise<any | null> {
  try {
    const r = await sql`select * from staff_accounts where username = ${user}`;
    return r.length ? r[0] : null;
  } catch (_) { return null; }
}
// Actions allowed while a reset password still has to be changed.
const MUST_CHANGE_OK = ["me", "changePassword"];
async function authenticate(req: any): Promise<Ctx> {
  if (req.token) {
    const p = await verifyToken(req.token);
    if (!p || p.v !== TOKEN_VERSION || STAFF_ROLES.indexOf(p.r as StaffRole) === -1) throw new Error("Session expired — please sign in again.");
    // the account must still exist with that role (STAFF_ACCOUNTS), and the session must not have been ended by a
    // password change / reset / "sign out everywhere" (session_version)
    const row = await accountRow(p.u);
    const acc = accountFrom(p.u, row);
    if (!acc || acc.role !== p.r || (row && row.disabled)) throw new Error("Session expired — please sign in again.");
    if (((row && row.session_version) || 1) !== (Number(p.sv) || 1)) throw new Error("Session expired — please sign in again.");
    const ctx: Ctx = { role: acc.role, user: p.u, perms: effectivePerms(acc.role, row && row.perms), mustChange: !!(row && row.must_change),
                       remember: !!p.rm, sv: Number(p.sv) || 1 };
    if (ctx.mustChange && MUST_CHANGE_OK.indexOf(String(req.action)) === -1) throw new Error("Please choose a new password first.");
    return ctx;
  }
  if (req.supervisor) {
    // Indexed existence check instead of pulling the whole distinct-supervisor list on every request.
    // Equivalent to "is this one of the names supervisorNames() would return".
    const name = String(req.supervisor);
    if (!name || name === "-" || name === "—") throw new Error("Unknown supervisor.");
    const hit = await sql`select 1 from pharmacists where supervisor = ${name} limit 1`;
    if (!hit.length) throw new Error("Unknown supervisor.");
    return { role: "supervisor", who: name, user: name };
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
// "Keep me signed in" (v6): 6 days instead of 10 hours. sv = the account's session version (see authenticate).
function tokenTtlHours(remember: boolean) { return remember ? CONFIG.REMEMBER_TTL_HOURS : CONFIG.TOKEN_TTL_HOURS; }
async function makeToken(user: string, role: StaffRole, remember = false, sv = 1): Promise<string> {
  const exp = Date.now() + tokenTtlHours(remember) * 3600 * 1000;
  const payload = b64urlFromBytes(encoder.encode(JSON.stringify({ u: user, e: exp, r: role, v: TOKEN_VERSION, sv, ...(remember ? { rm: 1 } : {}) })));
  return payload + "." + (await sign(payload));
}
async function verifyToken(tok: unknown): Promise<{ u: string; e: number; r?: string; v?: number; sv?: number; rm?: number } | null> {
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

/* ── Staff accounts ──
   STAFF_ACCOUNTS holds {username: {role, hash}} where hash = "pbkdf2$<iterations>$<salt b64>$<hash b64>"
   (PBKDF2-SHA256, 32-byte key) — so even someone who can read the secrets can't read a password. */
type Account = { role: StaffRole; hash?: string; pass?: string };
function staffAccounts(): Record<string, Account> {
  const raw = Deno.env.get("STAFF_ACCOUNTS");
  if (raw) {
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { throw new Error("STAFF_ACCOUNTS is not valid JSON (Edge Function secrets)."); }
    const out: Record<string, Account> = {};
    for (const name of Object.keys(parsed || {})) {
      const a = parsed[name] || {};
      if (STAFF_ROLES.indexOf(a.role) !== -1 && typeof a.hash === "string") out[name] = { role: a.role, hash: a.hash };
    }
    return out;
  }
  // Transition fallback (until STAFF_ACCOUNTS is set): the old shared logins.
  const out: Record<string, Account> = {};
  const tu = Deno.env.get("TRAINER_USER"), tp = Deno.env.get("TRAINER_PASS");
  const au = Deno.env.get("ADMIN_USER"), ap = Deno.env.get("ADMIN_PASS");
  if (tu && tp) out[tu] = { role: "trainer", pass: tp };
  if (au && ap) out[au] = { role: "coordinator", pass: ap };
  return out;
}
/* v7: the superadmin can also create accounts in the app. Those live only in staff_accounts (role + hash); the
   STAFF_ACCOUNTS ones keep their role from the secret. A username can't be in both (the secret wins). */
function accountFrom(user: string, row: any): Account | undefined {
  const secret = staffAccounts();
  if (Object.prototype.hasOwnProperty.call(secret, user)) return secret[user];
  if (row && row.role && STAFF_ROLES.indexOf(row.role) !== -1) return { role: row.role as StaffRole };
  return undefined;
}
async function allAccounts(): Promise<Record<string, Account & { app?: boolean }>> {
  const out: Record<string, Account & { app?: boolean }> = { ...staffAccounts() };
  try {
    const rows = await sql`select username, role from staff_accounts where role is not null`;
    for (const r of rows) {
      if (!Object.prototype.hasOwnProperty.call(out, r.username) && STAFF_ROLES.indexOf(r.role) !== -1) out[r.username] = { role: r.role, app: true };
    }
  } catch (_) { /* v6/v7 schema not run yet — secret accounts only */ }
  return out;
}
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
const DUMMY_HASH = "pbkdf2$150000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
async function passwordMatches(acc: Account | undefined, pw: string): Promise<boolean> {
  if (acc && acc.pass !== undefined) return safeEq(pw, acc.pass);
  // An unknown username still costs one hash, so response times don't reveal which usernames exist.
  const parts = String((acc && acc.hash) || DUMMY_HASH).split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!(iterations >= 10000 && iterations <= 1000000)) return false;
  const got = b64urlFromBytes(await pbkdf2(pw, b64urlToBytes(parts[2]), iterations));
  return !!acc && safeEq(got, parts[3].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

async function login(req: any) {
  if (!Object.keys(staffAccounts()).length) throw new Error("Staff accounts are not configured on the server (STAFF_ACCOUNTS secret).");
  const u = String(req.username || "").trim(), pw = String(req.password || "");
  // Lockout is per username (8 wrong passwords → 10 minutes), plus an overall cap against guessing many usernames.
  const userKey = "login_fails:" + u.toLowerCase().slice(0, 64);
  const fails = Number((await kvGet(userKey)) || 0);
  const allFails = Number((await kvGet("login_fails_all")) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS || allFails >= CONFIG.MAX_LOGIN_FAILS * 6) {
    throw new Error("Too many failed attempts. Please try again in a few minutes.");
  }
  // usernames are matched exactly (case-sensitive), like the passwords. `id` = the account's fixed username, which can
  // differ from what was typed once the superadmin has changed its sign-in username (v7.5).
  const id = u ? await resolveLogin(u) : null;
  const row = id ? await accountRow(id) : null;
  const base = id ? accountFrom(id, row) : undefined;
  const acc = withOwnPassword(base, row);
  if (!(await passwordMatches(acc, pw)) || !acc || !id) {
    await kvPut(userKey, String(fails + 1), CONFIG.LOCKOUT_MINUTES * 60);
    await kvPut("login_fails_all", String(allFails + 1), CONFIG.LOCKOUT_MINUTES * 60);
    await logActivity([{ username: u.slice(0, 64), role: acc ? acc.role : "", action: "login_failed", target_kind: "account", target_id: u.slice(0, 64),
      target_name: "", details: { reason: acc ? "wrong password" : "unknown username" } }]);
    await new Promise((r) => setTimeout(r, 1000));
    throw new Error("Invalid username or password.");
  }
  await kvRemove(userKey);
  // a switched-off account is told so only after the right password (no hint to someone guessing)
  if (row && row.disabled) throw new Error("This account is switched off — ask the super admin.");
  const remember = req.remember === true;
  await logActivity([{ username: id, role: acc.role, action: "login", target_kind: "account", target_id: id, target_name: "", details: remember ? { keepSignedIn: "6 days" } : {} }]);
  return { ok: true, token: await makeToken(id, acc.role, remember, (row && row.session_version) || 1), role: acc.role, user: id,
           ttlHours: tokenTtlHours(remember), remember, mustChange: !!(row && row.must_change),
           perms: effectivePerms(acc.role, row && row.perms), ...(await accountNamesFor(id, acc.role, row)) };
}
/* ── Account names (v7.5) ──
   staff_accounts.display_name: shown in the app instead of the username. staff_accounts.login_name: a different
   sign-in username. `username` stays the account's fixed id — tokens, permissions, the Activity Log and the
   "marked by" stamps keep using it, so nothing has to be rewritten when a name changes. */
// The account id a typed sign-in username belongs to, or null when that username was replaced by a new one.
async function resolveLogin(typed: string): Promise<string | null> {
  try {
    const hit = await sql`select username from staff_accounts where login_name = ${typed} limit 1`;
    if (hit.length) return hit[0].username;
    const own = await sql`select login_name from staff_accounts where username = ${typed} limit 1`;
    if (own.length && own[0].login_name) return null;   // renamed: the old username no longer signs in
  } catch (_) { /* v7.5 block of schema.sql not run yet: usernames only */ }
  return typed;
}
// Sent with sign-in and `me`: this account's sign-in username and display name, and the names to show for every
// account id (the superadmin also gets their sign-in usernames, for the Activity Log).
async function accountNamesFor(id: string, role: string, row: any) {
  const staffNames: Record<string, { n?: string; l?: string }> = {};
  try {
    for (const r of await sql`select username, display_name, login_name from staff_accounts where display_name <> '' or login_name is not null`) {
      const x: { n?: string; l?: string } = {};
      if (r.display_name) x.n = r.display_name;
      if (role === "superadmin" && r.login_name) x.l = r.login_name;
      if (x.n || x.l) staffNames[r.username] = x;
    }
  } catch (_) { /* v7.5 block not run yet */ }
  return { login: (row && row.login_name) || id, displayName: (row && row.display_name) || "", staffNames };
}
const cleanDisplayName = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
// Superadmin: set an account's display name and sign-in username. A new sign-in username signs the person out
// everywhere (except the superadmin's own session), so they sign in again with it. Empty / the original username =
// sign in with the original username again.
async function adminSetNames(ctx: Ctx, req: any) {
  const { u } = await accountName(req.username);
  const row = (await accountRow(u)) || {};
  const display = cleanDisplayName(req.displayName);
  let login = String(req.loginName ?? "").trim();
  if (login === u) login = "";
  if (login) {
    if (!USERNAME_RE.test(login)) throw new Error("The sign-in username must be 3–32 characters: letters, numbers, _ . or -");
    // unique ignoring case across every account's original username and every sign-in username
    const all = await allAccounts();
    if (Object.keys(all).some((x) => x !== u && x.toLowerCase() === login.toLowerCase())) throw new Error("That username is already taken.");
    const taken = await sql`select 1 from staff_accounts where username <> ${u} and (lower(username) = lower(${login}) or lower(login_name) = lower(${login})) limit 1`;
    if (taken.length) throw new Error("That username is already taken.");
  }
  const prevDisplay = row.display_name || "", prevLogin = row.login_name || "";
  const loginChanged = prevLogin !== login, bump = loginChanged && u !== ctx.user;
  await sql`insert into staff_accounts (username, display_name, login_name, session_version, updated_by)
            values (${u}, ${display}, ${login || null}, ${bump ? 2 : 1}, ${ctx.user || ""})
            on conflict (username) do update set display_name = ${display}, login_name = ${login || null},
              session_version = staff_accounts.session_version + ${bump ? 1 : 0}, updated_at = now(), updated_by = ${ctx.user || ""}`;
  if (loginChanged) {
    for (const x of [u, prevLogin, login]) if (x) await kvRemove("login_fails:" + x.toLowerCase().slice(0, 64));
  }
  const log: ActRow[] = [];
  if (display !== prevDisplay) log.push(act(ctx, "user_name", "account", u, u, { from: prevDisplay, to: display }));
  if (loginChanged) log.push(act(ctx, "user_login", "account", u, u, { from: prevLogin || u, to: login || u }));
  if (log.length) await logActivity(log);
  return { displayName: display, loginName: login || u, signedOut: bump };
}
// A password the person chose in the app (staff_accounts.hash) replaces the STAFF_ACCOUNTS one.
function withOwnPassword(acc: Account | undefined, row: any): Account | undefined {
  if (!acc) return acc;
  return row && row.hash ? { role: acc.role, hash: row.hash } : acc;
}
async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 150000;
  return "pbkdf2$" + iterations + "$" + b64urlFromBytes(salt) + "$" + b64urlFromBytes(await pbkdf2(pw, salt, iterations));
}
// Password rules: 10–128 characters, at least one letter and one number, not containing the username (either the
// original one or the sign-in username, v7.5).
function passwordProblem(pw: string, ...users: string[]): string {
  if (pw.length < 10) return "The new password must be at least 10 characters.";
  if (pw.length > 128) return "The new password is too long (128 characters at most).";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "The new password needs at least one letter and one number.";
  if (users.some((user) => user && pw.toLowerCase().includes(user.toLowerCase()))) return "The new password can't contain your username.";
  if (/^(.)\1+$/.test(pw)) return "The new password is too simple.";
  return "";
}
async function saveAccount(user: string, by: string, fields: { hash?: string; mustChange?: boolean; bump?: boolean; perms?: any }) {
  const r = await sql`insert into staff_accounts (username, hash, session_version, must_change, perms, updated_by)
    values (${user}, ${fields.hash ?? null}::text, ${fields.bump ? 2 : 1}, ${!!fields.mustChange}, ${sql.json(fields.perms || {})}, ${by})
    on conflict (username) do update set
      hash = coalesce(${fields.hash ?? null}::text, staff_accounts.hash),
      session_version = staff_accounts.session_version + ${fields.bump ? 1 : 0},
      must_change = ${fields.mustChange === undefined ? sql`staff_accounts.must_change` : !!fields.mustChange},
      perms = ${fields.perms === undefined ? sql`staff_accounts.perms` : sql.json(fields.perms)},
      updated_at = now(), updated_by = ${by}
    returning session_version`;
  return Number(r[0].session_version) || 1;
}
// Any signed-in staff member changes their own password: the current one is checked (wrong tries count towards the
// same lockout as sign-in), every other session of that account is signed out, and this one gets a fresh token.
async function changePassword(ctx: Ctx, req: any) {
  requireStaff(ctx);
  const u = ctx.user || "";
  const cur = String(req.current || ""), next = String(req.next || "");
  const userKey = "login_fails:" + u.toLowerCase().slice(0, 64);
  const fails = Number((await kvGet(userKey)) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS) throw new Error("Too many failed attempts. Please try again in a few minutes.");
  const row0 = await accountRow(u);
  const acc = withOwnPassword(accountFrom(u, row0), row0);
  if (!acc || !(await passwordMatches(acc, cur))) {
    await kvPut(userKey, String(fails + 1), CONFIG.LOCKOUT_MINUTES * 60);
    await logActivity([act(ctx, "password_change_failed", "account", u, u, { reason: "wrong current password" })]);
    await new Promise((r) => setTimeout(r, 1000));
    throw new Error("Your current password is not correct.");
  }
  const problem = passwordProblem(next, u, (row0 && row0.login_name) || "");
  if (problem) throw new Error(problem);
  if (next === cur) throw new Error("The new password must be different from the current one.");
  if (acc.pass === undefined && await passwordMatches(acc, next)) throw new Error("The new password must be different from the current one.");
  const sv = await saveAccount(u, u, { hash: await hashPassword(next), mustChange: false, bump: true });
  await logActivity([act(ctx, "password_change", "account", u, u, {})]);
  return { ok: true, token: await makeToken(u, ctx.role as StaffRole, !!ctx.remember, sv), ttlHours: tokenTtlHours(!!ctx.remember) };
}

/* ── Admins Permissions (superadmin) ── */
async function accountName(input: unknown): Promise<{ u: string; acc: Account & { app?: boolean } }> {
  const u = String(input || "");
  const all = await allAccounts();
  if (!Object.prototype.hasOwnProperty.call(all, u)) throw new Error("Unknown account.");
  return { u, acc: all[u] };
}
async function adminAccounts() {
  const all = await allAccounts();
  let rows: any[] = [];
  try { rows = await sql`select username, hash is not null as own, session_version, must_change, perms, disabled, created_at, created_by, updated_at, updated_by, display_name, login_name from staff_accounts`; }
  catch (_) { throw new Error("Run the v6, v7 and v7.5 blocks of schema.sql first (staff_accounts table)."); }
  const byUser: Record<string, any> = {};
  for (const r of rows) byUser[r.username] = r;
  const order: Record<string, number> = { superadmin: 0, trainer: 1, coordinator: 2 };
  return Object.keys(all).sort((a, b) => (order[all[a].role] - order[all[b].role]) || a.localeCompare(b)).map((u) => {
    const r = byUser[u] || {};
    return { username: u, displayName: r.display_name || "", loginName: r.login_name || u, role: all[u].role, app: !!all[u].app, disabled: !!r.disabled, ownPassword: !!r.own, mustChange: !!r.must_change,
      overrides: r.perms || {}, defaults: rolePerms(all[u].role), perms: effectivePerms(all[u].role, r.perms),
      createdAt: all[u].app && r.created_at ? new Date(r.created_at).toISOString() : null, createdBy: all[u].app ? (r.created_by || "") : "",
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null, updatedBy: r.updated_by || "" };
  });
}
async function adminSetPerms(ctx: Ctx, req: any) {
  const { u, acc } = await accountName(req.username);
  const role = acc.role;
  if (role === "superadmin") throw new Error("The super admin always has every permission.");
  const want = req.perms && typeof req.perms === "object" ? req.perms : {};
  const defaults = rolePerms(role), overrides: Record<string, boolean> = {};
  for (const k of PERM_KEYS) if (typeof want[k] === "boolean" && want[k] !== defaults[k]) overrides[k] = want[k];
  const before = effectivePerms(role, (await accountRow(u) || {}).perms);
  await saveAccount(u, ctx.user || "", { perms: overrides });
  const after = effectivePerms(role, overrides);
  const changed: Record<string, [boolean, boolean]> = {};
  for (const k of PERM_KEYS) if (before[k] !== after[k]) changed[k] = [before[k], after[k]];
  if (Object.keys(changed).length) await logActivity([act(ctx, "permissions", "account", u, u, changed)]);
  return { perms: after, overrides };
}
// A forgotten password: the superadmin sets a temporary one; the person must choose a new one at the next sign-in,
// and every open session of that account is signed out.
async function adminResetPassword(ctx: Ctx, req: any) {
  const { u } = await accountName(req.username);
  if (u === ctx.user) throw new Error("Use Change password for your own account.");
  const temp = String(req.temp || "");
  const login = ((await accountRow(u)) || {}).login_name || "";
  const problem = passwordProblem(temp, u, login);
  if (problem) throw new Error(problem.replace("The new password", "The temporary password").replace("your username", "their username"));
  await saveAccount(u, ctx.user || "", { hash: await hashPassword(temp), mustChange: true, bump: true });
  for (const x of [u, login]) if (x) await kvRemove("login_fails:" + x.toLowerCase().slice(0, 64));
  await logActivity([act(ctx, "password_reset", "account", u, u, {})]);
}
async function adminSignOut(ctx: Ctx, req: any) {
  const { u } = await accountName(req.username);
  await saveAccount(u, ctx.user || "", { bump: true });
  await logActivity([act(ctx, "sign_out_all", "account", u, u, {})]);
}
/* v7: new accounts made in the app. Trainer or coordinator only (a superadmin stays in STAFF_ACCOUNTS); the person
   signs in with a temporary password shown once to the superadmin and must choose their own straight away. */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
async function adminCreateUser(ctx: Ctx, req: any) {
  const u = String(req.username || "").trim();
  if (!USERNAME_RE.test(u)) throw new Error("The username must be 3–32 characters: letters, numbers, _ . or -");
  const role = String(req.role || "");
  if (role !== "trainer" && role !== "coordinator") throw new Error("Choose the role: Trainer or Coordinator.");
  const all = await allAccounts();
  if (Object.keys(all).some((x) => x.toLowerCase() === u.toLowerCase())) throw new Error("That username is already taken.");
  const old = await sql`select role from staff_accounts where lower(username) = lower(${u}) or lower(login_name) = lower(${u})`;
  if (old.length) throw new Error("That username is already taken.");
  const temp = String(req.temp || "");
  const problem = passwordProblem(temp, u);
  if (problem) throw new Error(problem.replace("The new password", "The temporary password").replace("your username", "their username"));
  const display = cleanDisplayName(req.displayName);
  await sql`insert into staff_accounts (username, role, hash, session_version, must_change, perms, created_by, updated_by, display_name)
            values (${u}, ${role}, ${await hashPassword(temp)}, 1, true, '{}'::jsonb, ${ctx.user || ""}, ${ctx.user || ""}, ${display})`;
  await logActivity([act(ctx, "user_create", "account", u, u, display ? { role, name: display } : { role })]);
}
async function adminSetDisabled(ctx: Ctx, req: any) {
  const { u, acc } = await accountName(req.username);
  if (u === ctx.user) throw new Error("You can't switch off your own account.");
  if (acc.role === "superadmin" && req.disabled) throw new Error("A super admin account can't be switched off here.");
  const off = req.disabled === true;
  await sql`insert into staff_accounts (username, disabled, session_version, updated_by) values (${u}, ${off}, 2, ${ctx.user || ""})
            on conflict (username) do update set disabled = ${off}, updated_at = now(), updated_by = ${ctx.user || ""},
              session_version = staff_accounts.session_version + ${off ? 1 : 0}`;
  await logActivity([act(ctx, off ? "user_disable" : "user_enable", "account", u, u, {})]);
}
async function adminDeleteUser(ctx: Ctx, req: any) {
  const { u, acc } = await accountName(req.username);
  if (!acc.app) throw new Error("Only accounts made in the app can be deleted — switch this one off instead (it is in STAFF_ACCOUNTS).");
  if (u === ctx.user) throw new Error("You can't delete your own account.");
  await sql`delete from staff_accounts where username = ${u}`;
  await logActivity([act(ctx, "user_delete", "account", u, u, { role: acc.role })]);
}

/* ═════════ Activity Log (append-only; the superadmin reads it) ═════════
   Best effort: a logging failure (e.g. the activity_log table not created yet) never blocks the actual change. */
type ActRow = { username: string; role: string; action: string; target_kind: string; target_id: string; target_name: string; details: any };
function act(ctx: Ctx, action: string, kind: string, id: string, name: string, details: any = {}): ActRow {
  return { username: ctx.user || ctx.who || "", role: ctx.role, action, target_kind: kind, target_id: id, target_name: name || "", details };
}
async function logActivity(rows: ActRow[]) {
  if (!rows.length) return;
  try {
    for (let i = 0; i < rows.length; i += 1000) {
      await sql`insert into activity_log (username, role, action, target_kind, target_id, target_name, details)
                select x.username, x.role, x.action, x.target_kind, x.target_id, x.target_name, x.details
                from jsonb_to_recordset(${sql.json(rows.slice(i, i + 1000) as any)}::jsonb)
                  as x(username text, role text, action text, target_kind text, target_id text, target_name text, details jsonb)`;
    }
  } catch (e) {
    console.error("[activity] could not write the log: " + String((e && (e as Error).message) || e));
  }
}
async function readActivity(req: any) {
  const limit = 500;
  const before = Number(req.before) > 0 ? Number(req.before) : null;      // paging: rows older than this id
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.from || "")) ? String(req.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.to || "")) ? String(req.to) : null;
  const user = req.user ? String(req.user) : null;
  const action = req.act ? String(req.act) : null;
  const q = req.q ? "%" + String(req.q).replace(/[%_\\]/g, (c) => "\\" + c) + "%" : null;
  // KSA days (UTC+3) for the date range
  const rows = await sql`select id, at, username, role, action, target_kind, target_id, target_name, details from activity_log
    where (${before}::bigint is null or id < ${before}::bigint)
      and (${from}::date is null or at >= (${from}::date - interval '3 hours'))
      and (${to}::date is null or at < (${to}::date + interval '21 hours'))
      and (${user}::text is null or username = ${user}::text)
      and (${action}::text is null or action = ${action}::text)
      and (${q}::text is null or username ilike ${q}::text or target_name ilike ${q}::text or target_id ilike ${q}::text or details::text ilike ${q}::text)
    order by id desc limit ${limit + 1}`;
  const facets = await sql`select array(select distinct username from activity_log where username <> '' order by 1) as users,
                                  array(select distinct action from activity_log order by 1) as actions`;
  return { rows: rows.slice(0, limit).map((r: any) => ({ ...r, id: Number(r.id), at: new Date(r.at).toISOString() })),
           more: rows.length > limit, users: facets[0].users || [], actions: facets[0].actions || [] };
}

/* ═════════ Who's online (supervisors ping while their page is open) ═════════ */
const PRESENCE_TTL_SECONDS = 150;   // the page pings every 60s, so a closed tab drops off within ~2.5 minutes
async function pingPresence(ctx: Ctx) {
  if (ctx.role !== "supervisor") return { ok: true };
  await kvPut("presence:" + ctx.who, nowIso(), PRESENCE_TTL_SECONDS);
  return { ok: true };
}
async function presence() {
  const rows = await sql`select key from kv_cache where key like 'presence:%' and expires_at > now()`;
  return { count: rows.length };
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
// Every staff account reads the roster, operations, training days, new-pharmacist list and merges (most tabs need
// them). The approval lists need "approvals.view"; the Core / Capsule data needs "attend.coreCapsule".
const APPROVAL_KEYS = ["leave-requests", "quota-approval-history", "pharmacist-notifications", "change-requests", "supervisor-submissions", "data-edit-requests"];
async function getKey(ctx: Ctx, key: string) {
  if (isStaff(ctx) && APPROVAL_KEYS.indexOf(key) !== -1) requirePerm(ctx, "approvals.view", "approvals.decide");
  if (isStaff(ctx) && key === "course-slots" && !can(ctx, "attend.coreCapsule")) return { records: [], settings: { core: null, capsule: null } };
  switch (key) {
    case "master-pharmacists": return await getMaster(ctx);
    case "operations": return await getOps(ctx);
    case "training-config": return await getConfig(ctx);
    case "company-logo": return { records: [], settings: { logo: (await settingsMap()).logo ?? null } };
    case "pending-pharmacists":
    case "leave-requests":
    case "quota-approval-history":
    case "pharmacist-notifications":
    case "change-requests": return await getTable(ctx, key);
    case "supervisor-submissions": requireStaff(ctx); return await getTable(ctx, key);
    case "group-merges": requireStaff(ctx); return await getTable(ctx, key);
    case "data-edit-requests": return await getTable(ctx, key);
    case "course-slots": return await getCourseSlots(ctx);
  }
  throw new Error("Unknown data key.");
}

function masterOf(r: any) {
  const m: any = {
    id: r.id, district: r.district, areaManager: r.area_manager, city: r.city,
    supervisor: r.supervisor, pharmacyNo: r.pharmacy_no, employeeId: r.employee_id, email: r.email,
    displayName: r.display_name, phone: r.phone, scfhs: r.scfhs, note: r.note,
  };
  // Core / Capsule completion no longer come from the roster (v5): they are read from the published course data
  // ("course-slots"). The old completion_pct / capsule_pct columns stay in the table but are not read or written.
  return m;
}
// Only the columns the caller actually receives are read — and a supervisor's rows are filtered in SQL rather
// than fetching the whole roster and discarding it. (Supervisors deliberately never get phone/licence details.)
async function getMaster(ctx: Ctx) {
  if (ctx.role === "supervisor") {
    const rows = await sql`select id, district, area_manager, city, supervisor, pharmacy_no, email, display_name, note
                           from pharmacists where display_name <> '' and supervisor = ${ctx.who} order by created_at`;
    return { records: rows.map((r: any) => {
      const m: any = { id: r.id, district: r.district, areaManager: r.area_manager, city: r.city,
        supervisor: r.supervisor, pharmacyNo: r.pharmacy_no, email: r.email, displayName: r.display_name, note: r.note };
      return { id: m.id, v: m };
    }), settings: {} };
  }
  const rows = await sql`select id, district, area_manager, city, supervisor, pharmacy_no, employee_id, email,
                                display_name, phone, scfhs, note
                         from pharmacists where display_name <> '' order by created_at`;
  return { records: rows.map((r: any) => ({ id: r.id, v: masterOf(r) })), settings: {} };
}
async function getOps(ctx: Ctx) {
  const rows = await sql`select id, supervisor, assignment, attendance, work_shift, history from pharmacists
                         where assignment is not null or attendance is not null or work_shift <> ''
                            or jsonb_array_length(coalesce(history, '[]'::jsonb)) > 0`;
  const recs: any[] = [];
  for (const r of rows) {
    const a = r.assignment, t = r.attendance, s = r.work_shift || null;
    const h = Array.isArray(r.history) && r.history.length ? r.history : null;
    if (!a && !t && !s && !h) continue;
    // Another supervisor's pharmacists: only which day they occupy (for seat counts) — never their history.
    if (ctx.role === "supervisor" && r.supervisor !== ctx.who) {
      if (a && a.type === "date") recs.push({ id: r.id, v: { a: { type: "date", dateId: a.dateId } } });
      continue;
    }
    recs.push({ id: r.id, v: h ? { a, t, s, h } : { a, t, s } });
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
  ["maxCapacity", "trainerNames", "coordinatorNames", "trainingNames", "cityRoster"].forEach((k) => {
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
  "change-requests": "Date Change",
  "supervisor-submissions": "Submission",
  "group-merges": "Group Merge",            // two parallel online groups run as one session (staff only)
  "data-edit-requests": "Data Edit",        // supervisor asks to correct a pharmacist's details
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
  if (isStaff(ctx)) checkWritePerms(ctx, key, records, settings);
  switch (key) {
    case "operations": {
      const stored = await patchOps(ctx, records);
      return stored && Object.keys(stored).length ? { ok: true, ops: stored } : { ok: true };
    }
    case "master-pharmacists": requireStaff(ctx); await patchMaster(ctx, records); break;
    case "training-config": requireStaff(ctx); await patchConfig(ctx, records, settings); break;
    case "company-logo": requireStaff(ctx); await patchSettings({ logo: settings.logo === undefined ? null : settings.logo });
      await logActivity([act(ctx, "setting", "setting", "logo", "Company logo", { changed: settings.logo ? "updated" : "removed" })]); break;
    case "pending-pharmacists":
    case "leave-requests":
    case "change-requests":
    case "pharmacist-notifications": await patchTableGuarded(ctx, key, records); break;
    case "quota-approval-history":
    case "supervisor-submissions": requireStaff(ctx); await patchApprovals(ctx, key, records); break;
    case "group-merges": requireStaff(ctx); await patchMerges(ctx, records); break;
    case "data-edit-requests": await patchTableGuarded(ctx, key, records); break;
    default: throw new Error("Unknown data key.");
  }
  return { ok: true };
}
// Staff writes, by permission (v6). Several screens write the same data (e.g. a booking changes from Attendance, from an
// approved request, from a roster upload or when a training day is deleted), so each kind of change accepts any of the
// permissions whose screen makes it.
const PERM_BOOKING = ["attend.assign", "attend.edit", "approvals.decide", "setup.master", "days.edit", "calendar.edit"];
function checkWritePerms(ctx: Ctx, key: string, records: Record<string, any>, settings: Record<string, any>) {
  const recs = Object.values(records || {});
  const has = (o: any, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  switch (key) {
    case "operations":
      for (const r of recs) {
        if (has(r, "a")) requirePerm(ctx, ...PERM_BOOKING);
        if (has(r, "t") && r.t !== null && r.t !== undefined) requirePerm(ctx, "attend.mark", "setup.master");
        if (has(r, "t") && (r.t === null || r.t === undefined)) requirePerm(ctx, "attend.mark", ...PERM_BOOKING);
        if (has(r, "s")) requirePerm(ctx, "attend.assign", "attend.mark", "setup.master");
      }
      return;
    case "master-pharmacists":
      if (recs.some((r) => r === null)) requirePerm(ctx, "attend.delete", "setup.master");
      if (recs.some((r) => r !== null)) requirePerm(ctx, "attend.edit", "attend.notes", "setup.master", "approvals.decide");
      return;
    case "training-config":
      if (recs.length) requirePerm(ctx, "days.edit", "calendar.edit");
      if (Object.keys(settings || {}).length) requirePerm(ctx, "setup.settings", "days.edit", "calendar.edit");
      return;
    case "company-logo": requirePerm(ctx, "setup.settings"); return;
    case "group-merges": requirePerm(ctx, "attend.merge"); return;
    default:   // the approval lists (requests, submissions, notifications, data edits)
      requirePerm(ctx, "approvals.decide");
  }
}

/* ---------- master roster (trainer only) ----------
   One transaction, a few set-based statements: a roster upload of ~1,500 people is all-or-nothing (a failure can't
   leave half the old list next to half the new one, i.e. duplicates) and takes 3 round trips instead of ~3,000. */
const MASTER_FIELDS: [string, string][] = [["displayName", "display_name"], ["email", "email"], ["supervisor", "supervisor"], ["district", "district"],
  ["areaManager", "area_manager"], ["city", "city"], ["pharmacyNo", "pharmacy_no"], ["employeeId", "employee_id"], ["phone", "phone"], ["scfhs", "scfhs"]];
async function patchMaster(ctx: Ctx, records: Record<string, any>) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  // Activity Log: what each pharmacist looked like before (only the rows being changed)
  const beforeRows = await sql`select id, display_name, email, supervisor, district, area_manager, city, pharmacy_no, employee_id, phone, scfhs,
                                      note from pharmacists where id = any(${ids}::text[])`;
  const before: Record<string, any> = {};
  for (const r of beforeRows) before[r.id] = r;
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
      // completionPct / capsulePct are ignored if sent (v5): completion comes from the published course data.
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
          note = case when d.note_set = '1' then d.note else p.note end
        from (select unnest(${upd}::text[]) as id, unnest(${c.district}::text[]) as district, unnest(${c.area}::text[]) as area,
                     unnest(${c.city}::text[]) as city, unnest(${c.sup}::text[]) as sup, unnest(${c.pharmacy}::text[]) as pharmacy,
                     unnest(${c.emp}::text[]) as emp, unnest(${c.email}::text[]) as email, unnest(${c.name}::text[]) as name,
                     unnest(${c.phone}::text[]) as phone, unnest(${c.scfhs}::text[]) as scfhs, unnest(${c.note}::text[]) as note,
                     unnest(${c.noteSet}::text[]) as note_set) d
        where p.id = d.id`;
    }
    if (ins.length) {
      const c = cols(ins);
      await tx`insert into pharmacists
          (id, district, area_manager, city, supervisor, pharmacy_no, employee_id, email, display_name, phone, scfhs, note)
        select * from unnest(${ins}::text[], ${c.district}::text[], ${c.area}::text[], ${c.city}::text[], ${c.sup}::text[],
                             ${c.pharmacy}::text[], ${c.emp}::text[], ${c.email}::text[], ${c.name}::text[], ${c.phone}::text[],
                             ${c.scfhs}::text[], ${c.note}::text[])`;
    }
  });
  // Activity Log: one row per pharmacist added / removed / actually changed (unchanged rows of an upload are skipped)
  const rows: ActRow[] = [];
  for (const id of ids) {
    const m = records[id], b = before[id];
    if (m === null) { if (b) rows.push(act(ctx, "pharmacist_delete", "pharmacist", id, b.display_name, { supervisor: b.supervisor, email: b.email })); continue; }
    if (!b) { rows.push(act(ctx, "pharmacist_add", "pharmacist", id, s(m.displayName), { supervisor: s(m.supervisor), email: s(m.email), city: s(m.city) })); continue; }
    const changes: Record<string, [string, string]> = {};
    for (const [k, col] of MASTER_FIELDS) if (s(m[k]) !== s(b[col])) changes[k] = [s(b[col]), s(m[k])];
    if (m.note !== undefined && s(m.note) !== s(b.note)) changes.note = [s(b.note), s(m.note)];
    if (Object.keys(changes).length) rows.push(act(ctx, "pharmacist_edit", "pharmacist", id, s(m.displayName) || b.display_name, { changes }));
  }
  await logActivity(rows);
}

// Activity Log helpers for assignments / attendance: only the meaningful parts, without the bookkeeping fields.
function actA(a: any) {
  if (!a) return null;
  if (a.type === "leave") return { status: a.status, locked: !!a.locked };
  return { dateId: a.dateId, locked: !!a.locked, ...(a.overQuota ? { overQuota: true, quotaApproved: !!a.quotaApproved } : {}), ...(a.retraining ? { retraining: a.retraining.attempt } : {}) };
}
function actT(t: any) {
  if (!t || typeof t !== "object") return null;
  const one = (x: any) => x ? { status: x.status || "", punctuality: x.punctuality || "", time: x.time || "", reason: x.reason || "" } : null;
  if (t.day1 || t.day2) return { day1: one(t.day1), day2: one(t.day2) };
  return one(t);
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ---------- assignments & attendance ---------- */
async function patchOps(ctx: Ctx, records: Record<string, any>) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const isSup = ctx.role === "supervisor";
  // Does this write actually move anyone between days? Marking attendance doesn't, and that's the common case.
  const changesAssignment = ids.some((id) => Object.prototype.hasOwnProperty.call(records[id] || {}, "a"));
  // Training days are needed when someone changes days (validation, and the retraining history); the capacity
  // default only to validate a supervisor's assignment. Marking attendance needs neither.
  let days: Record<string, any> = {};
  let defaultCap = CONFIG.DEFAULT_CAPACITY;
  if (changesAssignment) days = await daysMap();
  if (isSup && changesAssignment) defaultCap = Number((await settingsMap()).maxCapacity) || CONFIG.DEFAULT_CAPACITY;

  const logRows: ActRow[] = [];
  // What the server actually stored for every pharmacist whose day changed (assignment + attempt history) — sent
  // back so the page shows the "Retraining #n" marker and the signed-in "assigned by" without a reload.
  const opsOut: Record<string, { a: any; h: any[] }> = {};
  await sql.begin(async (tx: any) => {
    // Serialize only writes that change seat occupancy (the old script lock serialized everything). Attendance-only
    // writes can't overbook a day, so they don't queue behind each other.
    if (changesAssignment) await tx`select pg_advisory_xact_lock(911)`;

    // Read ONLY the rows being changed, instead of the whole roster.
    const rows = await tx`select id, supervisor, city, display_name, assignment, attendance, work_shift, history from pharmacists where id in ${tx(ids)}`;
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

    const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
    const updates: { id: string; a: any; t: any; s: string; h: any[] }[] = [];
    for (const id of ids) {
      const row = byId[id];
      if (!row) continue;
      const rec = records[id] || {};
      const curA = row.assignment, curT = row.attendance;
      let a = has(rec, "a") ? rec.a : curA;
      let t = has(rec, "t") ? rec.t : curT;
      const s = has(rec, "s") ? (rec.s || "") : (row.work_shift || "");
      if (s && WORK_SHIFTS.indexOf(s) === -1) throw new Error("Invalid work shift.");
      const sup = row.supervisor;

      if (ctx.role === "supervisor") {
        if (sup !== ctx.who) throw new Error("Not allowed: that pharmacist belongs to another supervisor.");
        if (has(rec, "t") && rec.t !== null) throw new Error("Only trainers can record attendance.");
        if (has(rec, "t") && !has(rec, "a")) throw new Error("Only trainers can change attendance.");
        const changing = has(rec, "a") && !sameAssignment(curA, rec.a);
        // Once a pharmacist has attended, only the training team may change their assignment (or clear the attendance).
        if (hasAttended(curT) && (changing || has(rec, "t"))) {
          throw new Error("This pharmacist already attended their training — only the training team can change it.");
        }
        // After Submit the choice is locked — also for a pharmacist who missed their training (Absent / Partial):
        // the lock always wins, so the supervisor rebooks them through Request Change.
        if (changing && curA && curA.locked) {
          throw new Error("This pharmacist's date was submitted and is locked — use Request Change.");
        }
        if (changing) {
          bump(curA, sup, -1);
          try {
            a = validateSupervisorAssignment(ctx, row, curA, rec.a, curT, days, counts, supCounts, defaultCap);
          } catch (e) { bump(curA, sup, +1); throw e; }
          bump(a, sup, +1);
        } else {
          a = curA;   // nothing actually changed — never let a resent copy drop or add the lock
        }
      } else {
        if (has(rec, "a")) {
          // The training team's own changes keep a submitted pharmacist locked for their supervisor — unless they
          // explicitly Unsubmit (locked: false, v7), which hands the choice back to the supervisor.
          if (a && curA && curA.locked && a.locked === false) {
            requirePerm(ctx, "attend.unsubmit");
            if (hasAttended(curT)) throw new Error(row.display_name + " already attended — nothing to unsubmit.");
          } else if (a && curA && curA.locked && !has(a, "locked")) a = { ...a, locked: true, lockedAt: curA.lockedAt || nowIso() };
          if (a && a.locked === false) { a = { ...a }; delete a.locked; delete a.lockedAt; }
          // "who" comes from the signed-in account, never from what the page sent
          if (a && !sameAssignment(curA, a)) a = { ...a, assignedBy: ctx.user, assignedAt: a.assignedAt || nowIso() };
          bump(curA, sup, -1);
          bump(a, sup, +1);
        }
        if (has(rec, "t") && t) t = stampMarkedBy(t, curT, ctx.user || "");
      }

      // Retraining: a pharmacist who missed their training and now gets a different day (or a leave status / no day)
      // keeps the missed attempt in their history instead of losing it. Moving them to another group on the SAME
      // date (Group Mix-up fix) is a correction, not a new attempt.
      let h: any[] = Array.isArray(row.history) ? row.history : [];
      const newDay = a && a.type === "date" ? days[a.dateId] : null, oldDay = curA && curA.type === "date" ? days[curA.dateId] : null;
      const sameDateMove = !!(newDay && oldDay && newDay.date && newDay.date === oldDay.date);
      if (has(rec, "a") && curA && curA.type === "date" && !sameAssignment(curA, a) && isFailed(curT) && !sameDateMove) {
        h = h.concat([{ dateId: curA.dateId, date: oldDay ? oldDay.date || "" : "", label: oldDay ? dayText(oldDay) : "",
          status: partOfTrainingAttended(curT) ? "Partial" : "Absent", reason: failReason(curT), attendance: actT(curT),
          endedAt: nowIso(), endedBy: ctx.user || ctx.who || "" }]);
        if (sameJson(t, curT)) t = null;   // that attendance belonged to the missed day
      }
      // The day booked after a missed one is a re-training (#2, #3 …) — derived from the history, so it can't drift.
      if (a && a.type === "date") {
        if (h.length) a = { ...a, retraining: { attempt: h.length + 1, originalDateId: h[0].dateId, originalDate: h[0].date } };
        else if (a.retraining) { a = { ...a }; delete a.retraining; }
      }
      if (has(rec, "a")) opsOut[id] = { a, h };
      updates.push({ id, a, t, s, h });
      // Activity Log: only the parts that actually changed
      const from: any = {}, to: any = {};
      if (!sameJson(actA(curA), actA(a))) { from.a = actA(curA); to.a = actA(a); }
      if (!sameJson(actT(curT), actT(t))) { from.t = actT(curT); to.t = actT(t); }
      if ((row.work_shift || "") !== s) { from.s = row.work_shift || ""; to.s = s; }
      if (Object.keys(to).length) {
        const unsub = !!(from.a && from.a.locked && to.a && !to.a.locked && sameAssignment(curA, a));
        const action = unsub ? "unsubmit" : to.a !== undefined || from.a !== undefined ? "date" : (to.t !== undefined || from.t !== undefined ? "attendance" : "shift");
        logRows.push(act(ctx, action, "pharmacist", id, row.display_name, { from, to }));
      }
    }

    // One statement for the whole batch — a bulk assign of 50 people is 1 round trip, not 50.
    if (updates.length) {
      const uIds = updates.map((u) => u.id);
      const uA = updates.map((u) => (u.a == null ? null : JSON.stringify(u.a)));
      const uT = updates.map((u) => (u.t == null ? null : JSON.stringify(u.t)));
      const uS = updates.map((u) => u.s);
      const uH = updates.map((u) => JSON.stringify(u.h || []));
      await tx`update pharmacists p
               set assignment = d.a::jsonb, attendance = d.t::jsonb, work_shift = d.s, history = d.h::jsonb
               from (select unnest(${uIds}::text[]) as id,
                            unnest(${uA}::text[]) as a,
                            unnest(${uT}::text[]) as t,
                            unnest(${uS}::text[]) as s,
                            unnest(${uH}::text[]) as h) d
               where p.id = d.id`;
    }
  });
  await logActivity(logRows);
  return opsOut;
}
// Readable name of a training day for the history / Activity Log ("Online QAS — 2026-10-11")
function dayText(d: any) { return d ? [d.trainingName || d.city || "", d.date || ""].filter(Boolean).join(" — ") : ""; }
function partOfTrainingAttended(t: any) {
  return !!(t && ((t.day1 && t.day1.status === "Attended") || (t.day2 && t.day2.status === "Attended")));
}
function failReason(t: any) {
  if (!t) return "";
  return [t.reason, t.day1 && t.day1.reason, t.day2 && t.day2.reason].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(" / ");
}

// Attendance written by the training team: markedBy is the signed-in username (per day for a 2-day training).
function stampMarkedBy(t: any, curT: any, user: string) {
  if (!t || typeof t !== "object") return t;
  if (t.day1 || t.day2) {
    const out = { ...t };
    for (const k of ["day1", "day2"]) {
      if (out[k] && !sameJson(actT(out[k]), actT(curT && curT[k]))) out[k] = { ...out[k], markedBy: user };
    }
    return out;
  }
  return sameJson(actT(t), actT(curT)) ? t : { ...t, markedBy: user };
}

const WORK_SHIFTS = ["Morning Shift", "Night Shift"];

// Missed their training: absent, or absent on one day of a 2-day online training (Partial).
function isFailed(t: any): boolean {
  if (!t || typeof t !== "object" || hasAttended(t)) return false;
  if (t.status === "Absent") return true;
  return !!((t.day1 && t.day1.status === "Absent") || (t.day2 && t.day2.status === "Absent"));
}

/* ---------- Submit: lock every choice the supervisor has made so far and tell the training team ---------- */
async function submitSupervisor(ctx: Ctx) {
  if (ctx.role !== "supervisor") throw new Error("Only supervisors can submit.");
  const at = nowIso();
  const out = await sql.begin(async (tx: any) => {
    // Submit locks what has been filled so far; empty rows stay open for a later Submit. A pharmacist booked
    // on a training day (not a leave status) needs a Work Shift for that day first.
    const missing = await tx`select count(*)::int as n from pharmacists
                             where supervisor = ${ctx.who} and display_name <> ''
                               and assignment->>'type' = 'date' and coalesce(work_shift, '') = ''`;
    if (missing[0].n) throw new Error(missing[0].n + " pharmacist(s) booked on a training day still need a Work Shift before you can submit.");
    const locked = await tx`update pharmacists
                            set assignment = assignment || ${sql.json({ locked: true, lockedAt: at })}::jsonb
                            where supervisor = ${ctx.who} and assignment is not null
                              and coalesce(assignment->>'locked', '') <> 'true'
                            returning id`;
    if (!locked.length) return { ok: true, locked: 0 };
    const tot = await tx`select (count(*) filter (where assignment->>'type' = 'date'))::int as dates,
                                (count(*) filter (where assignment->>'type' = 'leave'))::int as leaves,
                                (count(*) filter (where assignment is null))::int as unassigned
                         from pharmacists where supervisor = ${ctx.who} and display_name <> ''`;
    const id = "sub_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const data = { id, supervisor: ctx.who, submittedAt: at, newlyLocked: locked.length,
                   dates: tot[0].dates, leaves: tot[0].leaves, unassigned: tot[0].unassigned, status: "New" };
    await tx`insert into approvals (id, type, status, supervisor, pharmacist, submitted_at, decided_at, reason, data)
             values (${id}, 'Submission', 'New', ${ctx.who}, '', ${at}, '', '', ${sql.json(data)})`;
    return { ok: true, locked: locked.length, data };
  });
  if (out.locked) await logActivity([act(ctx, "submit", "supervisor", ctx.who || "", ctx.who || "", out.data)]);
  return { ok: true, locked: out.locked };
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

// A day can be visible to a supervisor but not editable by them ("readOnlySupervisors"): they can see it, but
// can't put pharmacists on it or take them off it — the training team does that (or approves a Request Change).
function readOnlyFor(day: any, who: string | undefined) {
  return !!(day && Array.isArray(day.readOnlySupervisors) && day.readOnlySupervisors.indexOf(who) !== -1);
}
// A pharmacist with no training day yet: when every day this supervisor can see for them (offline or online) is
// managed by the training team, their whole Date slot is locked — leave statuses included.
function noDateSlotLocked(ctx: Ctx, row: any, days: Record<string, any>) {
  const online = String(row.city).trim().toLowerCase() === "online";
  const mine = Object.values(days).filter((d: any) => d && d.active !== false && !!d.isOnline === online
    && (d.visibleSupervisors || []).indexOf(ctx.who) !== -1);
  return mine.length > 0 && mine.every((d: any) => readOnlyFor(d, ctx.who));
}
// Request Change is allowed when the supervisor can't change the pharmacist themselves: the choice was submitted
// (locked), their day is managed by the training team, or (no day yet) every day they could pick is managed.
// The lock always wins: a pharmacist who missed their training on a locked / managed day is rebooked this way too.
function changeRequestAllowed(ctx: Ctx, row: any, days: Record<string, any>) {
  const a = row.assignment;
  if (a && a.locked) return true;
  if (a && a.type === "date") return readOnlyFor(days[a.dateId], ctx.who);
  return noDateSlotLocked(ctx, row, days);
}
function validateSupervisorAssignment(ctx: Ctx, row: any, oldA: any, newA: any, curT: any, days: Record<string, any>, counts: Record<string, number>, supCounts: Record<string, Record<string, number>>, defaultCap: number) {
  if (!(oldA && oldA.type === "date") && noDateSlotLocked(ctx, row, days)) {
    throw new Error("The training team manages your training days — use Request Change.");
  }
  if (oldA && oldA.type === "date" && !(newA && newA.type === "date" && newA.dateId === oldA.dateId)
      && readOnlyFor(days[oldA.dateId], ctx.who)) {
    throw new Error("The training team manages that day — use Request Change.");
  }
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
    if (readOnlyFor(day, ctx.who)) throw new Error("The training team manages that day — use Request Change.");
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
async function patchConfig(ctx: Ctx, records: Record<string, any>, settings: Record<string, any>) {
  const ids = Object.keys(records);
  const before: Record<string, any> = {};
  if (ids.length) (await sql`select id, data from training_days where id = any(${ids}::text[])`).forEach((r: any) => { before[r.id] = r.data; });
  const prevSettings = Object.keys(settings).length ? await settingsMap() : {};
  for (const id of ids) {
    const d = records[id];
    if (d === null) { await sql`delete from training_days where id = ${id}`; continue; }
    await sql`insert into training_days (id, data, updated_at) values (${id}, ${jb(d)}, now())
              on conflict (id) do update set data = excluded.data, updated_at = now()`;
  }
  if (Object.keys(settings).length) await patchSettings(settings);
  // Activity Log: days added / removed / edited (field by field) and settings changed
  const dayName = (d: any) => d ? [d.trainingName || d.city || "", d.date || ""].filter(Boolean).join(" — ") : "";
  const rows: ActRow[] = [];
  for (const id of ids) {
    const d = records[id], b = before[id];
    if (d === null) { if (b) rows.push(act(ctx, "day_delete", "day", id, dayName(b), { date: b.date, city: b.city })); continue; }
    if (!b) { rows.push(act(ctx, "day_add", "day", id, dayName(d), { date: d.date, city: d.city })); continue; }
    const changes: Record<string, [unknown, unknown]> = {};
    new Set([...Object.keys(b), ...Object.keys(d)]).forEach((k) => { if (!sameJson(b[k], d[k])) changes[k] = [b[k] ?? null, d[k] ?? null]; });
    if (Object.keys(changes).length) rows.push(act(ctx, "day_edit", "day", id, dayName(d), { changes }));
  }
  for (const k of Object.keys(settings)) {
    if (!sameJson(prevSettings[k], settings[k])) rows.push(act(ctx, "setting", "setting", k, k, { from: prevSettings[k] ?? null, to: settings[k] ?? null }));
  }
  await logActivity(rows);
}

/* ---------- approvals / notifications ---------- */
function approvalColumns(key: string, obj: any) {
  const base = { supervisor: obj.supervisor || "", pharmacist: obj.displayName || "", reason: obj.rejectionReason || "", data: obj };
  if (key === "pending-pharmacists") return { ...base, type: "New Pharmacist", status: obj.status || "Pending", submitted_at: obj.addedAt || "", decided_at: obj.decidedAt || "" };
  if (key === "leave-requests") return { ...base, type: "Annual Leave", status: obj.status || "Pending", submitted_at: obj.requestedAt || "", decided_at: obj.decidedAt || "" };
  if (key === "change-requests") return { ...base, type: "Date Change", status: obj.status || "Pending", submitted_at: obj.requestedAt || "", decided_at: obj.decidedAt || "" };
  if (key === "supervisor-submissions") return { ...base, type: "Submission", status: obj.status || "New", submitted_at: obj.submittedAt || "", decided_at: obj.seenAt || "" };
  if (key === "group-merges") return { ...base, supervisor: "", pharmacist: (obj.dayLabels || []).join(" + "), type: "Group Merge", status: obj.status || "Active", submitted_at: obj.mergedAt || "", decided_at: obj.unmergedAt || "" };
  if (key === "data-edit-requests") return { ...base, type: "Data Edit", status: obj.status || "Pending", submitted_at: obj.requestedAt || "", decided_at: obj.decidedAt || "" };
  // quota-approval-history
  return { ...base, type: "Over-Quota Decision", status: obj.status || "", submitted_at: "", decided_at: obj.decidedAt || "" };
}
/* ---------- Group merges: two (or more) parallel online groups on the same date run as one session ----------
   Both training days keep their pharmacists (attendance is still marked per day); the merge record says who ran the
   combined session and how many attended in total. Staff only (trainers, coordinators, superadmin). */
async function patchMerges(ctx: Ctx, records: Record<string, any>) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const days = await daysMap();
  const existing: Record<string, any> = {};
  (await sql`select * from approvals where type = 'Group Merge'`).forEach((r: any) => { existing[r.id] = approvalFromRow(r); });
  const rows: ActRow[] = [];
  const safe: Record<string, any> = {};
  for (const id of ids) {
    const v = records[id], ex = existing[id];
    if (v === null) {
      if (ctx.role !== "superadmin" && ctx.role !== "trainer") throw new Error("Only trainers can delete a merge record — use Unmerge.");
      if (ex) rows.push(act(ctx, "merge_delete", "Group Merge", id, (ex.dayLabels || []).join(" + "), {}));
      safe[id] = null;
      continue;
    }
    const dayIds: string[] = Array.isArray(v.dayIds) ? v.dayIds.map(String) : [];
    const ds = dayIds.map((d) => days[d]);
    if (dayIds.length < 2 || new Set(dayIds).size !== dayIds.length) throw new Error("A merge needs at least two different groups.");
    if (ds.some((d) => !d)) throw new Error("One of the merged groups no longer exists.");
    if (ds.some((d) => !d.isOnline)) throw new Error("Only online groups can be merged.");
    if (new Set(ds.map((d) => d.date)).size !== 1) throw new Error("Only groups running on the same date can be merged.");
    const attendees = Number(v.attendees);
    if (!(attendees >= 0 && attendees <= 100000) || Math.floor(attendees) !== attendees) throw new Error("Total attendees must be a whole number.");
    const status = v.status === "Unmerged" ? "Unmerged" : "Active";
    if (status === "Active") {
      for (const other of Object.values(existing)) {
        if (other.id === id || other.status !== "Active") continue;
        const clash = (other.dayIds || []).find((d: string) => dayIds.indexOf(d) !== -1);
        if (clash) throw new Error("A group is already part of another merge — unmerge that one first.");
      }
    }
    const out: any = { ...v, id, dayIds, date: ds[0].date, attendees, status,
      mergedBy: ex ? ex.mergedBy : ctx.user, mergedAt: ex ? ex.mergedAt : nowIso() };
    if (status === "Unmerged" && (!ex || ex.status !== "Unmerged")) { out.unmergedBy = ctx.user; out.unmergedAt = nowIso(); }
    if (status === "Active") { delete out.unmergedBy; delete out.unmergedAt; }
    const name = (out.dayLabels || []).join(" + ") || dayIds.join(" + ");
    if (!ex) rows.push(act(ctx, "merge", "Group Merge", id, name, { date: out.date, trainer: out.trainer || "", coordinator: out.coordinator || "", attendees }));
    else if (ex.status !== status) rows.push(act(ctx, status === "Unmerged" ? "unmerge" : "merge", "Group Merge", id, name, {}));
    else {
      const changes: Record<string, [unknown, unknown]> = {};
      for (const k of ["trainer", "coordinator", "attendees", "note"]) if (!sameJson(ex[k], out[k])) changes[k] = [ex[k] ?? null, out[k] ?? null];
      if (Object.keys(changes).length) rows.push(act(ctx, "merge_edit", "Group Merge", id, name, { changes }));
    }
    safe[id] = out;
    existing[id] = out;   // later records in the same batch see this one
  }
  await patchApprovals(ctx, "group-merges", safe, true);
  await logActivity(rows);
}

async function patchApprovals(ctx: Ctx, key: string, records: Record<string, any>, quiet = false) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const prev: Record<string, any> = {};
  (await sql`select id, status, supervisor, pharmacist from approvals where id = any(${ids}::text[])`).forEach((r: any) => { prev[r.id] = r; });
  const type = APPROVAL_TYPE[key] || key;
  const rows: ActRow[] = [];
  for (const id of ids) {
    let v = records[id];
    const p = prev[id];
    if (v === null) {
      await sql`delete from approvals where id = ${id}`;
      if (p) rows.push(act(ctx, isStaff(ctx) ? "approval_delete" : "request_cancel", type, id, p.pharmacist || p.supervisor, { status: p.status, supervisor: p.supervisor }));
      continue;
    }
    const statusChanged = !p || String(p.status || "") !== String(v.status || "");
    // A decision is stamped with the signed-in account that made it
    if (isStaff(ctx) && p && statusChanged) v = { ...v, decidedBy: ctx.user };
    if (statusChanged) {
      rows.push(act(ctx, isStaff(ctx) ? (p ? "approval" : "approval_add") : "request", type, id, v.displayName || v.pharmacistName || v.supervisor || "",
        { from: p ? p.status : null, to: v.status || null, supervisor: v.supervisor || "", reason: v.rejectionReason || v.reason || "" }));
    }
    const c = approvalColumns(key, v);
    await sql`insert into approvals (id, type, status, supervisor, pharmacist, submitted_at, decided_at, reason, data)
      values (${id}, ${c.type}, ${c.status}, ${c.supervisor}, ${c.pharmacist}, ${c.submitted_at}, ${c.decided_at}, ${c.reason}, ${jb(c.data)})
      on conflict (id) do update set type = excluded.type, status = excluded.status, supervisor = excluded.supervisor,
        pharmacist = excluded.pharmacist, submitted_at = excluded.submitted_at, decided_at = excluded.decided_at,
        reason = excluded.reason, data = excluded.data`;
  }
  if (!quiet) await logActivity(rows);
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

/* Supervisor "Request Data Edit": only the pharmacist's own row fields may be requested (never their supervisor,
   area manager or district). "from" is taken from the database for the fields the supervisor can see; for Employee ID,
   Phone and SCFHS (never sent to supervisors) it stays empty so the request doesn't reveal them. */
const DATA_EDIT_FIELDS: Record<string, string | null> = {
  displayName: "display_name", email: "email", pharmacyNo: "pharmacy_no", city: "city",
  employeeId: null, phone: null, scfhs: null,
};
function cleanDataEditChanges(changes: any, row: any) {
  if (!Array.isArray(changes) || !changes.length) throw new Error("Choose at least one detail to change.");
  const seen = new Set<string>();
  const out: any[] = [];
  for (const c of changes) {
    const field = String((c && c.field) || "");
    if (!Object.prototype.hasOwnProperty.call(DATA_EDIT_FIELDS, field) || seen.has(field)) throw new Error("That detail can't be changed through a request.");
    seen.add(field);
    const to = String((c && c.to) ?? "").trim().slice(0, 200);
    if (!to) throw new Error("A requested value can't be empty.");
    if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("That email address doesn't look right.");
    const col = DATA_EDIT_FIELDS[field];
    const from = col ? String(row[col] ?? "") : "";
    if (col && from === to) continue;   // nothing to change
    out.push({ field, from, to, decision: "" });
  }
  if (!out.length) throw new Error("Nothing would change — the details are already like that.");
  return out;
}

async function patchTableGuarded(ctx: Ctx, key: string, records: Record<string, any>) {
  if (isStaff(ctx)) {   // "approvals.decide" was checked in patchKey
    if (key === "pharmacist-notifications") return await patchNotifications(records);
    return await patchApprovals(ctx, key, records);
  }
  if (ctx.role !== "supervisor") throw new Error("Not available for this login.");
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
    if (key === "change-requests") {
      const own = await sql`select city, assignment, attendance from pharmacists where id = ${String(v.pharmacistId || "")} and supervisor = ${ctx.who}`;
      if (!own.length) throw new Error("Not allowed: that pharmacist belongs to another supervisor.");
      // Request Change is only for pharmacists the supervisor can't change themselves: submitted (locked) or on a
      // day / slot the training team manages. An empty or still-open row is simply changed on the page.
      if (!ex) {
        const row = own[0];
        const days = await daysMap();
        if (hasAttended(row.attendance)) throw new Error("That pharmacist already attended — only the training team can change it.");
        if (!changeRequestAllowed(ctx, row, days)) {
          throw new Error("Request Change is only for submitted or training-team-managed pharmacists — change this one directly in the table.");
        }
        if (v.to && v.to.type === "date") {
          const d = days[String(v.to.dateId || "")];
          const online = String(row.city).trim().toLowerCase() === "online";
          if (!d || !!d.isOnline !== online) throw new Error("Online pharmacists can only move to online days (and vice versa).");
        }
      }
    }
    if (key === "data-edit-requests") {
      const own = await sql`select display_name, email, pharmacy_no, city from pharmacists where id = ${String(v.pharmacistId || "")} and supervisor = ${ctx.who}`;
      if (!own.length) throw new Error("Not allowed: that pharmacist belongs to another supervisor.");
      safe[id] = { ...v, changes: cleanDataEditChanges(v.changes, own[0]) };
      continue;
    }
    safe[id] = v;
  }
  if (key === "pharmacist-notifications") return await patchNotifications(safe);
  return await patchApprovals(ctx, key, safe);
}

/* ═════════════════════════════════════════ REPORTS (v5) ═════════════════════════════════════════
   Course completion lives in courses / course_progress / course_uploads (schema.sql, "v5 — Reports") and report_hidden (v6).
   - Staff: Moodle Reports parses the LMS sheets IN THE BROWSER and publishes computed rows (coursePublish); a publish
     replaces the course's rows. Reports Configuration manages courses, the public display and the Core/Capsule slots.
   - Public (reports.html, no login): reportsPublic (aggregates only) and reportsPublicCourse (the rows of one active
     course, by its unguessable share slug) — read-only, rate-limited per IP, cached 60 s.
   - Schedule results (On time / Late / Overdue …) depend on "now", so they are computed when read, never stored.
     A finished learner whose final-video time couldn't be read (final_at null) is always "Completed (date unknown)" —
     never On time or Late. The exclusion list used at publish time is never sent here; only its count is logged. */
const COURSE_STATES = ["Completed", "Final video done, others missing", "In progress", "Not started"];
const FINISHED_STATES = ["Completed", "Final video done, others missing"];
const DISPLAY_COLUMNS = ["num", "district", "areaManager", "city", "supervisor", "email", "name", "rate", "state", "completionDate", "daysLeft"];
const DEFAULT_DISPLAY = { columns: DISPLAY_COLUMNS.slice(), showDeadline: true, showDaysLeft: true, includeRosterNoData: false };
const MAX_PUBLISH_ROWS = 20000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[A-Za-z0-9_-]{24}$/;

function randomToken(len: number): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";   // 64 symbols → no modulo bias
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += abc[b & 63];
  return s;
}
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v) ? v.slice(0, maxItems).map((x) => str(x, maxLen)).filter(Boolean) : [];
function isoOrNull(v: unknown, label: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  if (isNaN(t)) throw new Error(label + " is not a valid date.");
  const y = new Date(t).getUTCFullYear();
  if (y < 2000 || y > 2100) throw new Error(label + " is out of range.");
  return new Date(t).toISOString();
}
const isoOf = (v: any) => (v ? new Date(v).toISOString() : null);

function courseOut(r: any, uploads?: any[]) {
  const o: any = {
    id: r.id, name: r.name, source: r.source, active: !!r.active, displayName: r.display_name, category: r.category,
    sortOrder: r.sort_order, deadline: isoOf(r.deadline), display: { ...DEFAULT_DISPLAY, ...(r.display || {}) }, engine: r.engine || {},
    shareSlug: r.share_slug, createdAt: isoOf(r.created_at), createdBy: r.created_by, lastPublishedAt: isoOf(r.last_published_at),
    lastPublishedBy: r.last_published_by, rowCount: r.row_count,
  };
  if (uploads) o.uploads = uploads;
  return o;
}
function uploadOut(u: any) {
  return { id: Number(u.id), at: isoOf(u.at), by: u.by_user, files: u.files || [], stats: u.stats || {}, settings: u.settings || {} };
}
async function courseById(id: unknown) {
  const rows = await sql`select * from courses where id = ${String(id || "")}`;
  if (!rows.length) throw new Error("That course no longer exists.");
  return rows[0];
}
// Public responses are cached per isolate for 60 s; staff changes clear it so they show up quickly on this instance.
const publicCache = new Map<string, { at: number; data: any }>();
function clearPublicCache() { publicCache.clear(); }

/* ---------- staff: courses ---------- */
async function coursesList() {
  const courses = await sql`select * from courses order by sort_order, lower(coalesce(nullif(display_name, ''), name))`;
  const ups = await sql`select * from (select u.*, row_number() over (partition by course_id order by at desc) as rn from course_uploads u) x
                        where rn <= 10 order by course_id, at desc`;
  const byCourse: Record<string, any[]> = {};
  for (const u of ups) (byCourse[u.course_id] ||= []).push(uploadOut(u));
  const st = await settingsMap();
  return { courses: courses.map((c: any) => courseOut(c, byCourse[c.id] || [])),
           coreCourseId: st.coreCourseId || null, capsuleCourseId: st.capsuleCourseId || null,
           categoryColors: cleanCategoryColors(st.categoryColors) };
}

// Display options: only the known keys are taken from the request, merged over what is stored (so options added later
// by a newer page aren't lost when an older page saves).
function cleanDisplay(d: any, prev: any) {
  const out: any = { ...DEFAULT_DISPLAY, ...(prev || {}) };
  if (!d || typeof d !== "object") return out;
  if (Array.isArray(d.columns)) out.columns = DISPLAY_COLUMNS.filter((c) => d.columns.indexOf(c) !== -1);
  for (const k of ["showDeadline", "showDaysLeft", "includeRosterNoData"]) if (k in d) out[k] = !!d[k];
  // card colour on the public page (v7): "#rrggbb", or "" for the default
  // card fill and text colour (v7.1); "" = default / automatic
  for (const k of ["color", "bg", "text"]) if (k in d) out[k] = /^#[0-9a-fA-F]{6}$/.test(String(d[k] || "")) ? String(d[k]).toLowerCase() : "";
  return out;
}

async function courseSave(ctx: Ctx, c: any) {
  if (!c || typeof c !== "object") throw new Error("Missing course details.");
  const name = str(c.name, 1000);
  if (!name || name.length > 150) throw new Error("The course name must be 1–150 characters.");
  const source = c.source === "sap" ? "sap" : (c.source === "moodle" ? "moodle" : "");
  if (!source) throw new Error("Choose the course source (Moodle or SAP).");
  const id = c.id ? String(c.id) : "";
  const clash = await sql`select id from courses where lower(name) = lower(${name}) and id <> ${id}`;
  if (clash.length) throw new Error("A course with that name is already tracked.");
  const sortOrder = Math.max(-100000, Math.min(100000, Math.round(Number(c.sortOrder) || 0)));
  const prevRow = id ? await courseById(id) : null;
  const fields = {
    name, source, active: !!c.active, display_name: str(c.displayName, 150), category: str(c.category, 80),
    sort_order: sortOrder,
    // the deadline is normally set in Moodle Reports (on publish): an edit that doesn't send it keeps the stored one
    deadline: "deadline" in c ? isoOrNull(c.deadline, "The deadline") : (prevRow ? isoOf(prevRow.deadline) : null),
  };
  if (id) {
    const prev = prevRow;
    if (prev.source !== source && prev.row_count > 0) throw new Error("The source can't be changed after data was published for this course.");
    const display = cleanDisplay(c.display, prev.display);
    const rows = await sql`update courses set name = ${fields.name}, source = ${fields.source}, active = ${fields.active},
        display_name = ${fields.display_name}, category = ${fields.category}, sort_order = ${fields.sort_order},
        deadline = ${fields.deadline}, display = ${sql.json(display)} where id = ${id} returning *`;
    const changes: Record<string, [unknown, unknown]> = {};
    const before: any = { name: prev.name, source: prev.source, active: prev.active, display_name: prev.display_name, category: prev.category,
      sort_order: prev.sort_order, deadline: isoOf(prev.deadline), display: { ...DEFAULT_DISPLAY, ...(prev.display || {}) } };
    const after: any = { ...fields, display };
    for (const k of Object.keys(after)) if (!sameJson(before[k], after[k])) changes[k] = [before[k] ?? null, after[k] ?? null];
    if (Object.keys(changes).length) await logActivity([act(ctx, "course_edit", "course", id, name, { changes })]);
    clearPublicCache();
    return courseOut(rows[0]);
  }
  const newId = "crs_" + randomToken(12);
  const display = cleanDisplay(c.display, null);
  const rows = await sql`insert into courses (id, name, source, active, display_name, category, sort_order, deadline, display, share_slug, created_by)
      values (${newId}, ${fields.name}, ${fields.source}, ${fields.active}, ${fields.display_name}, ${fields.category}, ${fields.sort_order},
              ${fields.deadline}, ${sql.json(display)}, ${randomToken(24)}, ${ctx.user || ""}) returning *`;
  await logActivity([act(ctx, "course_add", "course", newId, name, { source, active: fields.active })]);
  clearPublicCache();
  return courseOut(rows[0], []);
}

async function courseDelete(ctx: Ctx, id: unknown) {
  const c = await courseById(id);
  await sql.begin(async (tx: any) => {
    await tx`delete from courses where id = ${c.id}`;   // progress + uploads cascade
    // a deleted course can't keep feeding the Attendance tab's Core / Capsule column
    for (const k of ["coreCourseId", "capsuleCourseId"]) {
      await tx`update settings set value = 'null'::jsonb where key = ${k} and value = ${sql.json(c.id)}`;
    }
  });
  await logActivity([act(ctx, "course_delete", "course", c.id, c.name, { rows: c.row_count })]);
  clearPublicCache();
}

async function courseShareRotate(ctx: Ctx, id: unknown) {
  const c = await courseById(id);
  const slug = randomToken(24);
  await sql`update courses set share_slug = ${slug} where id = ${c.id}`;
  await logActivity([act(ctx, "course_share_rotate", "course", c.id, c.name, {})]);
  clearPublicCache();
  return slug;
}

/* Category colours (v7.2): {category: {color, bg, text}} in settings.categoryColors. Every course of a category uses
   them, except for the colours the course sets itself. */
const HEX6 = /^#[0-9a-fA-F]{6}$/;
function cleanCategoryColors(input: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  if (!input || typeof input !== "object") return out;
  for (const name of Object.keys(input as any).slice(0, 200)) {
    const cat = String(name).trim().slice(0, 80), v = (input as any)[name] || {};
    if (!cat) continue;
    const c: any = {};
    for (const k of ["color", "bg", "text"]) if (HEX6.test(String(v[k] || ""))) c[k] = String(v[k]).toLowerCase();
    if (Object.keys(c).length) out[cat] = c;
  }
  return out;
}
function categoryColorsByKey(saved: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  const clean = cleanCategoryColors(saved);
  for (const k of Object.keys(clean)) out[k.toLowerCase()] = clean[k];
  return out;
}
async function categoryColorsSet(ctx: Ctx, input: unknown) {
  const next = cleanCategoryColors(input);
  const prev = cleanCategoryColors((await settingsMap()).categoryColors);
  await patchSettings({ categoryColors: next });
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) if (!sameJson(prev[k] || null, next[k] || null)) changes[k] = [prev[k] || null, next[k] || null];
  if (Object.keys(changes).length) await logActivity([act(ctx, "category_colors", "category", "colors", "Category colours", { changes })]);
  clearPublicCache();
  return next;
}
async function courseSlotsSet(ctx: Ctx, core: unknown, capsule: unknown) {
  const pick = async (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    return (await courseById(v)).id as string;
  };
  const coreId = await pick(core), capsuleId = await pick(capsule);
  const prev = await settingsMap();
  await patchSettings({ coreCourseId: coreId, capsuleCourseId: capsuleId });
  const changes: Record<string, [unknown, unknown]> = {};
  if ((prev.coreCourseId || null) !== coreId) changes.coreCourseId = [prev.coreCourseId || null, coreId];
  if ((prev.capsuleCourseId || null) !== capsuleId) changes.capsuleCourseId = [prev.capsuleCourseId || null, capsuleId];
  if (Object.keys(changes).length) await logActivity([act(ctx, "course_slots", "course", "slots", "Core / Capsule courses", { changes })]);
}

/* ---------- staff: publish ---------- */
function cleanPublishRow(r: any, i: number, seen: Set<string>) {
  const where = "Row " + (i + 1) + ": ";
  if (!r || typeof r !== "object") throw new Error(where + "invalid row.");
  const email = String(r.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) throw new Error(where + "missing or invalid email.");
  if (seen.has(email)) throw new Error(where + "the email " + email + " appears twice.");
  seen.add(email);
  const state = String(r.state ?? "");
  if (COURSE_STATES.indexOf(state) === -1) throw new Error(where + "unknown state.");
  const done = Number(r.done), total = Number(r.total), rate = Number(r.rate);
  if (!Number.isInteger(done) || !Number.isInteger(total) || done < 0 || total < 0 || done > total) throw new Error(where + "invalid videos done / total.");
  if (!(rate >= 0 && rate <= 100)) throw new Error(where + "the rate must be between 0 and 100.");
  const finalDone = r.final_done === true;
  if (finalDone && FINISHED_STATES.indexOf(state) === -1) throw new Error(where + "a completed final video needs a finished state.");
  const tooLong = (v: unknown) => String(v ?? "").length > 200;
  if (tooLong(r.final_at_raw) || tooLong(r.latest_raw) || tooLong(r.lms_name)) throw new Error(where + "a text value is longer than 200 characters.");
  if (r.missing !== undefined && (!Array.isArray(r.missing) || r.missing.length > 500)) throw new Error(where + "invalid list of missing videos.");
  return {
    email, lms_name: str(r.lms_name, 200), sources: str(r.sources, 500), done, total, rate: Math.round(rate * 10) / 10, state,
    final_done: finalDone, final_status: str(r.final_status, 200),
    // final_at stays null when the file's timestamp couldn't be read → "Completed (date unknown)", never On time / Late
    final_at: finalDone ? isoOrNull(r.final_at, where + "final_at") : null,
    final_at_raw: str(r.final_at_raw, 200),
    latest_at: isoOrNull(r.latest_at, where + "latest_at"), latest_raw: str(r.latest_raw, 200),
    missing: strList(r.missing, 500, 200),
  };
}
const STAT_KEYS = ["rowsIn", "students", "stored", "excluded", "noEmail", "matchedRoster", "matchedOnboarding", "notInRoster", "unreadableTimestamps"];
function cleanStats(s: any) {
  const out: Record<string, number> = {};
  for (const k of STAT_KEYS) { const n = Number(s && s[k]); if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n); }
  return out;
}
// "Settings used" for the audit row: known keys only (the exclusion list and the session-only cut-off are never kept)
function cleanPublishSettings(s: any) {
  const out: any = {};
  if (!s || typeof s !== "object") return out;
  if (Array.isArray(s.finalVideos)) out.finalVideos = s.finalVideos.slice(0, 50).map((f: any) => ({ sheet: str(f && f.sheet, 200), video: str(f && f.video, 200) }));
  for (const k of ["includedVideos", "acceptedStatuses", "rejectedStatuses"]) out[k] = strList(s[k], 500, 200);
  for (const k of ["mergeRule", "includedSummary"]) if (s[k] !== undefined) out[k] = str(s[k], 1000);
  return out;
}
function cleanFiles(f: any) {
  return Array.isArray(f) ? f.slice(0, 50).map((x: any) => ({
    fileName: str(x && x.fileName, 200), label: str(x && x.label, 200),
    rows: Math.max(0, Math.round(Number(x && x.rows) || 0)), videos: Math.max(0, Math.round(Number(x && x.videos) || 0)) })) : [];
}
function cleanEngine(e: any) {
  return { finalVideos: strList(e && e.finalVideos, 500, 200), acceptedStatuses: strList(e && e.acceptedStatuses, 500, 200),
           excludedVideos: strList(e && e.excludedVideos, 500, 200) };
}

async function coursePublish(ctx: Ctx, req: any) {
  const c = await courseById(req.courseId);
  if (c.source !== "moodle") throw new Error("Only Moodle courses can be published for now.");
  if (!Array.isArray(req.rows) || !req.rows.length) throw new Error("There is nothing to publish.");
  if (req.rows.length > MAX_PUBLISH_ROWS) throw new Error("Too many rows (more than " + MAX_PUBLISH_ROWS + ").");
  const seen = new Set<string>();
  const rows = req.rows.map((r: any, i: number) => cleanPublishRow(r, i, seen));
  const deadline = isoOrNull(req.deadline, "The deadline");
  const engine = cleanEngine(req.engine);
  const files = cleanFiles(req.files);
  const settings = cleanPublishSettings(req.settings);
  const stats: any = cleanStats(req.stats);
  // roster matching is recounted here rather than trusted from the page
  const emails = rows.map((r: any) => r.email);
  const rosterHit = await sql`select count(distinct lower(trim(email)))::int as n from pharmacists
                              where display_name <> '' and lower(trim(email)) = any(${emails}::text[])`;
  stats.stored = rows.length;
  stats.matchedRoster = rosterHit[0].n;
  stats.notInRoster = rows.length - rosterHit[0].n;
  stats.unreadableTimestamps = stats.unreadableTimestamps || 0;

  await sql.begin(async (tx: any) => {
    await tx`delete from course_progress where course_id = ${c.id}`;
    for (let i = 0; i < rows.length; i += 2000) {
      const chunk = rows.slice(i, i + 2000);
      await tx`insert into course_progress (course_id, email, lms_name, sources, done, total, rate, state, final_done, final_status,
                                            final_at, final_at_raw, latest_at, latest_raw, missing)
               select ${c.id}, x.email, x.lms_name, x.sources, x.done, x.total, x.rate, x.state, x.final_done, x.final_status,
                      x.final_at, x.final_at_raw, x.latest_at, x.latest_raw, coalesce(x.missing, '[]'::jsonb)
               from jsonb_to_recordset(${sql.json(chunk as any)}::jsonb) as x(email text, lms_name text, sources text, done int, total int,
                      rate numeric, state text, final_done boolean, final_status text, final_at timestamptz, final_at_raw text,
                      latest_at timestamptz, latest_raw text, missing jsonb)`;
    }
    await tx`update courses set engine = ${sql.json(engine)}, deadline = ${deadline}, last_published_at = now(),
               last_published_by = ${ctx.user || ""}, row_count = ${rows.length} where id = ${c.id}`;
    await tx`insert into course_uploads (course_id, by_user, files, stats, settings)
             values (${c.id}, ${ctx.user || ""}, ${sql.json(files)}, ${sql.json(stats)}, ${sql.json({ ...settings, deadline: deadline || "" })})`;
  });
  await logActivity([act(ctx, "course_publish", "course", c.id, c.name, { ...stats, files: files.length })]);
  clearPublicCache();
  return { stored: rows.length, stats };
}

/* ---------- the merge used by the export and the public page ----------
   Every progress row resolves its person: the roster (pharmacists, by email) wins; else "Not in roster" (the name
   from the LMS file). With includeNoData, roster people missing from the upload are added as "No completion data".
   People not in the roster can be hidden from the reports (report_hidden, v6): the public page leaves them out of
   its tables and counts (skipHidden); the staff export keeps them, marked hidden. A hidden email that later joins
   the roster shows again — the roster always wins. */
type MergedRow = {
  email: string; name: string; district: string; areaManager: string; city: string; supervisor: string;
  flag: "roster" | "not_in_roster" | "no_data"; hidden: boolean; p: any | null; dateId?: string;
};
type PeopleRef = { byRoster: Map<string, any>; hidden: Set<string> };
async function peopleRef(): Promise<PeopleRef> {
  const roster = await sql`select lower(trim(email)) as email, display_name, district, area_manager, city, supervisor, assignment
                           from pharmacists where display_name <> '' and trim(email) <> '' order by created_at`;
  const hid = await sql`select email from report_hidden`;
  const byRoster = new Map<string, any>();
  for (const r of roster) if (!byRoster.has(r.email)) byRoster.set(r.email, r);
  return { byRoster, hidden: new Set<string>(hid.map((h: any) => h.email)) };
}
const dateIdOf = (r: any) => (r && r.assignment && r.assignment.type === "date" ? String(r.assignment.dateId || "") : "");
// "Online QAS - 11, 12 Oct 26" / "JED - 5 Oct 26": training name (online) or city, then the date (both days of a 2-day online training)
function pubDayLabel(day: any): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.date || ""))) return "";
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d1 = new Date(day.date + "T00:00:00Z"), yy = String(d1.getUTCFullYear()).slice(-2);
  let txt = d1.getUTCDate() + " " + M[d1.getUTCMonth()] + " " + yy;
  if (day.isOnline && day.onlineFormat === "split") {
    const d2 = new Date(d1.getTime() + 864e5);
    txt = d1.getUTCMonth() === d2.getUTCMonth() ? d1.getUTCDate() + ", " + d2.getUTCDate() + " " + M[d1.getUTCMonth()] + " " + yy
      : d1.getUTCDate() + " " + M[d1.getUTCMonth()] + ", " + d2.getUTCDate() + " " + M[d2.getUTCMonth()] + " " + yy;
  }
  const where = day.isOnline ? (day.trainingName || "Online") : (day.city || day.trainingName || "");
  return (where ? where + " - " : "") + txt;
}
async function mergedCourseRows(courseId: string, includeNoData: boolean, ref?: PeopleRef, skipHidden = false) {
  const { byRoster, hidden } = ref || await peopleRef();
  const prog = await sql`select * from course_progress where course_id = ${courseId}`;
  const out: MergedRow[] = [];
  const seen = new Set<string>();
  for (const p of prog) {
    seen.add(p.email);
    const r = byRoster.get(p.email);
    const isHidden = !r && hidden.has(p.email);
    if (isHidden && skipHidden) continue;
    out.push({ email: p.email, name: (r && r.display_name) || p.lms_name || p.email,
      district: r ? r.district : "", areaManager: r ? r.area_manager : "", city: r ? r.city : "", supervisor: r ? r.supervisor : "",
      flag: r ? "roster" : "not_in_roster", hidden: isHidden, p, dateId: dateIdOf(r) });
  }
  if (includeNoData) {
    for (const [email, r] of byRoster) {
      if (seen.has(email)) continue;
      out.push({ email, name: r.display_name, district: r.district, areaManager: r.area_manager, city: r.city, supervisor: r.supervisor, flag: "no_data", hidden: false, p: null, dateId: dateIdOf(r) });
    }
  }
  return out;
}
function aggregateOf(rows: MergedRow[]) {
  // modules = videos counted in the rate (the "N modules" badge on the public page)
  const a = { total: rows.length, completed: 0, finalOnly: 0, inProgress: 0, notStarted: 0, noData: 0, notInRoster: 0, avgRate: 0, modules: 0 };
  let sum = 0, n = 0;
  for (const r of rows) {
    if (r.flag === "not_in_roster") a.notInRoster++;
    if (!r.p) { a.noData++; continue; }
    const rate = Number(r.p.rate);
    sum += rate; n++;
    if (Number(r.p.total) > a.modules) a.modules = Number(r.p.total);
    if (r.p.state === "Completed") a.completed++;
    else if (r.p.state === "Final video done, others missing") a.finalOnly++;
    else if (rate > 0) a.inProgress++;
    else a.notStarted++;
  }
  a.avgRate = n ? Math.round((sum / n) * 10) / 10 : 0;
  return a;
}
// Deadline result, computed at read time. A finished learner without a readable time is never On time / Late.
function scheduleOf(p: any, deadline: any, now = Date.now()) {
  if (!deadline || !p) return { schedule: "", days: 0 };
  const dl = new Date(deadline).getTime();
  if (p.final_done) {
    if (!p.final_at) return { schedule: "Completed (date unknown)", days: 0 };
    const t = new Date(p.final_at).getTime();
    if (t <= dl) return { schedule: "On time", days: 0 };
    return { schedule: "Late", days: Math.ceil((t - dl) / 864e5) };
  }
  if (now > dl) return { schedule: "Overdue", days: Math.ceil((now - dl) / 864e5) };
  return { schedule: "Still within deadline", days: 0 };
}

/* ---------- staff: full export (unmasked) ---------- */
async function courseExport(id: unknown, includeNoData: unknown) {
  const c = await courseById(id);
  const display = { ...DEFAULT_DISPLAY, ...(c.display || {}) };
  const inc = typeof includeNoData === "boolean" ? includeNoData : !!display.includeRosterNoData;
  const merged = await mergedCourseRows(c.id, inc);
  const last = await sql`select * from course_uploads where course_id = ${c.id} order by at desc limit 1`;
  const now = Date.now();
  const rows = merged.map((m) => {
    const p = m.p, sc = scheduleOf(p, c.deadline, now);
    return { name: m.name, email: m.email, district: m.district, areaManager: m.areaManager, city: m.city, supervisor: m.supervisor,
      match: m.flag, hidden: m.hidden, sources: p ? p.sources : "", done: p ? p.done : null, total: p ? p.total : null, rate: p ? Number(p.rate) : null,
      state: p ? p.state : "No completion data", finalDone: p ? p.final_done : false, finalStatus: p ? p.final_status : "",
      finalAt: p ? isoOf(p.final_at) : null, finalAtRaw: p ? p.final_at_raw : "", latestAt: p ? isoOf(p.latest_at) : null,
      latestRaw: p ? p.latest_raw : "", missing: p ? p.missing : [], schedule: sc.schedule, scheduleDays: sc.days };
  });
  return { course: courseOut(c), lastUpload: last.length ? uploadOut(last[0]) : null, includeNoData: inc, rows };
}

/* ---------- staff: people not in the roster (v6, Moodle Reports section 8) ----------
   Everyone in any published course whose email isn't in the roster, with the courses they appear in. The superadmin
   and coordinators can hide them from the reports (public page tables and counts) or show them again. */
async function notInRosterList() {
  const rows = await sql`select cp.email, max(cp.lms_name) as name,
                                array_agg(distinct coalesce(nullif(c.display_name, ''), c.name)) as courses,
                                max(c.last_published_at) as last_seen, h.hidden_by, h.hidden_at
                         from course_progress cp
                         join courses c on c.id = cp.course_id
                         left join report_hidden h on h.email = cp.email
                         where not exists (select 1 from pharmacists p where p.display_name <> '' and lower(trim(p.email)) = cp.email)
                         group by cp.email, h.hidden_by, h.hidden_at
                         order by cp.email`;
  return rows.map((r: any) => ({ email: r.email, name: r.name || "", courses: (r.courses || []).filter(Boolean).sort(),
    lastSeen: isoOf(r.last_seen), hidden: !!r.hidden_at, hiddenBy: r.hidden_by || "", hiddenAt: isoOf(r.hidden_at) }));
}
async function reportHideSet(ctx: Ctx, input: unknown, hide: unknown) {
  const emails = [...new Set((Array.isArray(input) ? input : []).map((e) => String(e ?? "").trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e) && e.length <= 254))].slice(0, 5000);
  if (!emails.length) throw new Error("Choose at least one person.");
  let changed: any[];
  if (hide === true) {
    changed = await sql`insert into report_hidden (email, hidden_by)
                        select x, ${ctx.user || ""} from unnest(${emails}::text[]) as x
                        on conflict (email) do nothing returning email`;
  } else if (hide === false) {
    changed = await sql`delete from report_hidden where email = any(${emails}::text[]) returning email`;
  } else throw new Error("Invalid request.");
  await logActivity(changed.map((r: any) => act(ctx, hide ? "report_hide" : "report_unhide", "person", r.email, r.email, {})));
  clearPublicCache();
  return changed.length;
}

/* ---------- Core / Capsule for the Hub ("course-slots" read key) ----------
   Staff get every row of the two courses ({s: state, r: rate, f: final_at, d: final_done}); supervisors get nothing
   (the supervisor page no longer shows Core / Capsule). */
async function getCourseSlots(ctx: Ctx) {
  if (ctx.role === "supervisor") return { records: [], settings: { core: null, capsule: null } };
  const st = await settingsMap();
  const slot = async (courseId: unknown) => {
    if (!courseId) return null;
    const cs = await sql`select id, name, display_name, last_published_at from courses where id = ${String(courseId)}`;
    if (!cs.length) return null;
    const c = cs[0];
    const byEmail: Record<string, any> = {};
    const rows = await sql`select email, state, rate, final_at, final_done from course_progress where course_id = ${c.id}`;
    for (const r of rows) byEmail[r.email] = { s: r.state, r: Number(r.rate), f: isoOf(r.final_at), d: !!r.final_done };
    return { courseId: c.id, name: c.display_name || c.name, lastPublishedAt: isoOf(c.last_published_at), byEmail };
  };
  return { records: [], settings: { core: await slot(st.coreCourseId), capsule: await slot(st.capsuleCourseId) } };
}

/* ---------- public (reports.html): read-only, rate-limited, cached; only the enabled columns are sent ---------- */
const PUBLIC_RATE_PER_MIN = 30;
async function publicRateLimit(ip: string) {
  const minute = Math.floor(Date.now() / 60000);
  const key = "rl:" + ip.slice(0, 64) + ":" + minute;
  const exp = new Date(Date.now() + 120000).toISOString();
  // one atomic statement: create the counter or add 1 to it
  const r = await sql`insert into kv_cache (key, value, expires_at) values (${key}, '1', ${exp})
                      on conflict (key) do update set value = ((coalesce(nullif(kv_cache.value, ''), '0'))::int + 1)::text
                      returning value`;
  if (Number(r[0].value) > PUBLIC_RATE_PER_MIN) {
    try {   // daily count of refused requests (no per-request logging)
      const day = "rlhits:" + new Date().toISOString().slice(0, 10);
      await sql`insert into kv_cache (key, value, expires_at) values (${day}, '1', ${new Date(Date.now() + 8 * 864e5).toISOString()})
                on conflict (key) do update set value = ((coalesce(nullif(kv_cache.value, ''), '0'))::int + 1)::text`;
    } catch (_) { /* best effort */ }
    throw new Error("Too many requests — try again in a minute");
  }
  // expired counters are cleared now and then (kv_cache rows expire but aren't removed on their own)
  if (Math.random() < 0.02) { try { await sql`delete from kv_cache where key like 'rl:%' and expires_at < now()`; } catch (_) { /* ignore */ } }
}
function publicCourseHead(c: any, agg: any, catColors: Record<string, any> = {}) {
  const d = { ...DEFAULT_DISPLAY, ...(c.display || {}) };
  // a course's own colour wins; an empty one follows its category's colour (v7.2)
  const cat = catColors[String(c.category || "").trim().toLowerCase()] || {};
  const head: any = { slug: c.share_slug, title: c.display_name || c.name, category: c.category, order: c.sort_order, source: c.source,
    lastPublishedAt: isoOf(c.last_published_at),
    display: { columns: d.columns, showDeadline: !!d.showDeadline, showDaysLeft: !!d.showDaysLeft, includeRosterNoData: !!d.includeRosterNoData, color: d.color || cat.color || "", bg: d.bg || cat.bg || "", text: d.text || cat.text || "" },
    agg };
  // the deadline is sent when it is shown, or when Days Left needs it
  if (d.showDeadline || d.showDaysLeft) head.deadline = isoOf(c.deadline);
  return head;
}
async function cachedPublic(key: string, build: () => Promise<any>) {
  const hit = publicCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const data = await build();
  publicCache.set(key, { at: Date.now(), data });
  return data;
}
async function reportsPublic() {
  return await cachedPublic("overview", async () => {
    const courses = await sql`select * from courses where active = true order by sort_order, lower(coalesce(nullif(display_name, ''), name))`;
    const ref = await peopleRef();
    const cats = categoryColorsByKey((await settingsMap()).categoryColors);
    const out: any[] = [];
    for (const c of courses) {
      const d = { ...DEFAULT_DISPLAY, ...(c.display || {}) };
      out.push(publicCourseHead(c, aggregateOf(await mergedCourseRows(c.id, !!d.includeRosterNoData, ref, true)), cats));
    }
    return { ok: true, generatedAt: new Date().toISOString(), courses: out };
  });
}
async function reportsPublicCourse(slug: unknown) {
  const s = String(slug || "");
  if (!SLUG_RE.test(s)) throw new Error("Report unavailable");
  return await cachedPublic("course:" + s, async () => {
    const cs = await sql`select * from courses where share_slug = ${s} and active = true`;
    if (!cs.length) throw new Error("Report unavailable");
    const c = cs[0];
    const d = { ...DEFAULT_DISPLAY, ...(c.display || {}) };
    const cols = new Set<string>(d.columns || []);
    const merged = await mergedCourseRows(c.id, !!d.includeRosterNoData, undefined, true);
    const days = await daysMap();   // every training day, visible to supervisors or hidden
    // Only the columns switched on in Reports Configuration are sent (server-side, not just hidden on screen).
    const rows = merged.map((m) => {
      const p = m.p;
      const o: any = { s: p ? p.state : "No completion data", fd: !!(p && p.final_done), fl: m.flag };
      if (cols.has("name")) o.n = m.name;
      // full email (owner decision, v5 UI round): hide the Email column per course in Reports Configuration to send none
      if (cols.has("email")) o.e = m.email;
      if (cols.has("district")) o.di = m.district;
      if (cols.has("areaManager")) o.am = m.areaManager;
      if (cols.has("city")) o.ci = m.city;
      if (cols.has("supervisor")) o.su = m.supervisor;
      if (cols.has("rate")) o.r = p ? Number(p.rate) : null;
      if (cols.has("completionDate")) o.f = p && p.final_done ? isoOf(p.final_at) : null;
      // Training Date filter (v7): the roster person's booked training day — date (for sorting) and label
      const day = m.dateId ? days[m.dateId] : null;
      if (day && day.date) { o.td = String(day.date); o.tl = pubDayLabel(day); }
      return o;
    });
    return { ok: true, generatedAt: new Date().toISOString(), course: publicCourseHead(c, aggregateOf(merged), categoryColorsByKey((await settingsMap()).categoryColors)), rows };
  });
}
