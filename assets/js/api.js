/* ════════════════════════════════════════════════════════════════════
   Backend client + storage adapter
   ------------------------------------------------------------------
   The app code was written against a tiny key/value store
   (getShared / setShared). This file keeps that interface but talks to
   the Supabase backend, and — importantly — sends only the
   RECORDS THAT CHANGED (a diff against what this page last read), so two
   people saving different rows at the same time no longer overwrite each other.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const CFG = window.APP_CONFIG || {};
  const TOKEN_KEY = 'upc_trainer_token';

  const APP_HOOKS = { onAuthExpired: null, onSaveFailed: null, onOpsUpdated: null };
  window.APP_HOOKS = APP_HOOKS;

  /* ───────────── transport ───────────── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ───────────── status indicator (are we loading / saving right now?) ─────────────
     Every request goes through transport(), so counting requests here (rather than
     sprinkling flags through every click handler) covers the whole app in one place. */
  let pendingReads = 0, pendingWrites = 0;
  let flashState = null, flashTimer = null;
  const statusListeners = [];
  function computeStatus() {
    if (pendingWrites > 0) return 'saving';
    if (pendingReads > 0) return 'loading';
    return flashState || 'idle';
  }
  function emitStatus() {
    const s = computeStatus();
    statusListeners.forEach(fn => { try { fn(s); } catch (e) {} });
  }
  // shows a brief confirmation once everything currently in flight has finished
  function flashSaved() {
    flashState = 'saved';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashState = null; emitStatus(); }, 1400);
    emitStatus();
  }
  window.onApiStatusChange = function (fn) { statusListeners.push(fn); fn(computeStatus()); };

  // One attempt. Anything that looks like a temporary server / network hiccup is flagged `transient` so it can be retried.
  async function transportOnce(body) {
    if (!CFG.API_URL) throw new Error('Backend URL is not configured (assets/js/config.js).');
    let res;
    try {
      // The anon key only lets the request REACH the Edge Function; all real auth (trainer token /
      // supervisor scope) is enforced inside it. The function answers the CORS pre-flight.
      res = await fetch(CFG.API_URL, {
        method: 'POST', redirect: 'follow', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'apikey': CFG.SUPABASE_ANON, 'Authorization': 'Bearer ' + CFG.SUPABASE_ANON }
      });
    } catch (e) {
      const err = new Error('Network problem — check your connection');
      err.transient = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error('Server error (HTTP ' + res.status + ')');
      err.transient = res.status === 404 || res.status === 408 || res.status === 429 || res.status >= 500;
      throw err;
    }
    try {
      return await res.json();
    } catch (e) {
      const err = new Error('The server returned an unexpected response');   // an HTML error page instead of JSON
      err.transient = true;
      throw err;
    }
  }

  // A serverless backend can occasionally answer a perfectly good request with a 5xx / HTML page, mostly when
  // several requests hit at once. Every request here is safe to repeat (writes are per-record upserts/deletes),
  // so temporary failures are retried a couple of times before the user ever sees an error.
  // Open any page with ?debug=1 to log, per request, how long the round-trip took versus how long the server
  // itself spent (`_ms`) — that is what tells you whether a slow moment is the network or the database.
  const DEBUG = (() => { try { return new URLSearchParams(location.search).get('debug') === '1'; } catch (e) { return false; } })();
  function logTiming(body, t0, out) {
    if (!DEBUG) return;
    const label = body.action + (body.key ? ':' + body.key : (body.keys ? ':' + body.keys.length + ' keys' : ''));
    const rt = Math.round((performance.now ? performance.now() : Date.now()) - t0);
    const server = out && out._ms != null ? out._ms : null;
    console.log('[api] ' + label + ' — ' + rt + 'ms round-trip' + (server != null ? ' (' + server + 'ms server, ' + Math.max(rt - server, 0) + 'ms network)' : ''));
  }

  // `quiet` requests (the background "I'm online" ping, the online-supervisors count) don't flash the status indicator.
  async function transport(body, quiet) {
    const isWrite = body.action === 'patch' || body.action === 'submit';
    if (!quiet) { if (isWrite) pendingWrites++; else pendingReads++; emitStatus(); }
    const t0 = performance.now ? performance.now() : Date.now();
    try {
      const waits = [700, 1800];
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await transportOnce(body);
          logTiming(body, t0, out);
          return out;
        } catch (e) {
          if (!e.transient || attempt >= waits.length) throw e;
          await sleep(waits[attempt]);
        }
      }
    } finally {
      if (!quiet) { if (isWrite) pendingWrites--; else pendingReads--; emitStatus(); }
    }
  }

  /* ───────────── session ───────────── */
  const API = {
    mode: null,          // 'supervisor' | 'trainer'
    supervisor: null,

    init(mode) { API.mode = mode; },
    setSupervisor(name) { API.supervisor = name; },

    hasToken() { try { return !!sessionStorage.getItem(TOKEN_KEY); } catch (e) { return false; } },
    clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} },

    async call(action, extra, quiet) {
      const body = Object.assign({ action }, extra || {});
      if (API.mode === 'trainer') {
        let tok = null;
        try { tok = sessionStorage.getItem(TOKEN_KEY); } catch (e) {}
        if (tok) body.token = tok;
      } else if (API.supervisor) {
        body.supervisor = API.supervisor;
      }
      const out = await transport(body, quiet);
      if (!out || out.ok === false) {
        const err = new Error((out && out.error) || 'Request failed');
        if (/sign in again|Not authorised/i.test(err.message) && API.mode === 'trainer') {
          err.authExpired = true;
          API.clearToken();
          if (APP_HOOKS.onAuthExpired) APP_HOOKS.onAuthExpired();
        }
        throw err;
      }
      return out;
    },

    async login(username, password) {
      const out = await transport({ action: 'login', username, password });
      if (!out || out.ok === false) throw new Error((out && out.error) || 'Sign-in failed');
      try { sessionStorage.setItem(TOKEN_KEY, out.token); } catch (e) { throw new Error('Your browser is blocking session storage.'); }
      API.role = out.role || 'trainer';
      API.user = out.user || username;
      return true;
    },
    logout() { API.clearToken(); API.role = null; API.user = null; },
    // 'superadmin' (everything + Activity Log), 'trainer' (everything else) or 'coordinator' (Attendance tab, Calendar
    // view, Master Sheet Preview, Import Completion) — known after sign-in / verifySession. `user` is the account name.
    role: null,
    user: null,
    async verifySession() {
      if (!API.hasToken()) return false;
      try { const out = await API.call('me'); API.role = out.role || 'trainer'; API.user = out.user || null; return true; } catch (e) { return false; }
    },
    // Super admin only: one page (500 rows, newest first) of the Activity Log. filters = {from, to, user, act, q, before}
    async activity(filters) { return await API.call('activity', filters || {}); },

    async supervisorNames() { return (await API.call('supervisors')).names || []; },
    async venues() { return (await API.call('venues')).venues || []; },
    // Supervisor presses Submit: locks every choice made so far; returns how many pharmacists were newly locked.
    async submit() { return (await API.call('submit')).locked || 0; },
    // Supervisor page heartbeat, and the trainer's "supervisors online" count — both silent.
    async ping() { return API.call('ping', null, true); },
    async presence() { return (await API.call('presence', null, true)).count || 0; }
  };
  window.API = API;

  /* ───────────── canonical form + diff ───────────── */
  const ARRAY_KEYS = ['master-pharmacists', 'pending-pharmacists', 'leave-requests', 'quota-approval-history', 'pharmacist-notifications', 'change-requests', 'supervisor-submissions', 'group-merges', 'data-edit-requests'];
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function stable(v) {
    if (v === undefined) return 'u';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }

  // canon = { records:{id:value}, order:[id], settings:{k:v} }
  function emptyCanon() { return { records: {}, order: [], settings: {} }; }

  function canonFromWire(key, data) {
    const c = emptyCanon();
    (data.records || []).forEach(r => { c.records[r.id] = clone(r.v); c.order.push(r.id); });
    c.settings = clone(data.settings || {});
    if (key === 'training-config') {
      // a brand-new sheet has none of these yet — give every caller the shape the app code expects
      ['trainerNames', 'coordinatorNames', 'trainingNames'].forEach(k => { if (!Array.isArray(c.settings[k])) c.settings[k] = []; });
      if (!c.settings.maxCapacity) c.settings.maxCapacity = 30;
    }
    return c;
  }

  function valueFromCanon(key, c) {
    if (ARRAY_KEYS.includes(key)) return c.order.map(id => clone(c.records[id]));
    if (key === 'operations') {
      // history (h) = the pharmacist's missed earlier attempts — written only by the server, never sent back
      const out = { assignments: {}, attendance: {}, shifts: {}, history: {} };
      c.order.forEach(pid => {
        const r = c.records[pid] || {};
        if (r.a) out.assignments[pid] = clone(r.a);
        if (r.t) out.attendance[pid] = clone(r.t);
        if (r.s) out.shifts[pid] = r.s;
        if (r.h && r.h.length) out.history[pid] = clone(r.h);
      });
      return out;
    }
    if (key === 'training-config') {
      const cfg = clone(c.settings) || {};
      cfg.dates = c.order.map(id => clone(c.records[id]));
      return cfg;
    }
    if (key === 'company-logo') return c.settings.logo === undefined ? null : c.settings.logo;
    if (key === 'course-slots') return { core: c.settings.core || null, capsule: c.settings.capsule || null };   // read-only (v5)
    return null;
  }

  function canonFromValue(key, value) {
    const c = emptyCanon();
    if (ARRAY_KEYS.includes(key)) {
      (value || []).forEach(item => { c.records[item.id] = clone(item); c.order.push(item.id); });
    } else if (key === 'operations') {
      const asg = (value && value.assignments) || {}, att = (value && value.attendance) || {}, sh = (value && value.shifts) || {};
      const hi = (value && value.history) || {};
      new Set([...Object.keys(asg), ...Object.keys(att), ...Object.keys(sh), ...Object.keys(hi)]).forEach(pid => {
        const r = {};
        if (asg[pid]) r.a = clone(asg[pid]);
        if (att[pid]) r.t = clone(att[pid]);
        if (sh[pid]) r.s = sh[pid];
        if (hi[pid] && hi[pid].length) r.h = clone(hi[pid]);
        if (Object.keys(r).length) { c.records[pid] = r; c.order.push(pid); }
      });
    } else if (key === 'training-config') {
      const v = value || {};
      (v.dates || []).forEach(d => { c.records[d.id] = clone(d); c.order.push(d.id); });
      Object.keys(v).forEach(k => { if (k !== 'dates' && v[k] !== undefined) c.settings[k] = clone(v[k]); });
    } else if (key === 'company-logo') {
      c.settings.logo = value === undefined ? null : value;
    }
    return c;
  }

  function diffCanon(key, oldC, newC, allowDelete) {
    const records = {}, settings = {};
    const ids = new Set([...Object.keys(newC.records), ...(allowDelete ? Object.keys(oldC.records) : [])]);
    ids.forEach(id => {
      const o = oldC.records[id], n = newC.records[id];
      if (key === 'operations') {
        // The server sends "none" as null while the page drops the key entirely — treat both as the same, or every
        // save would re-send every assigned-but-unmarked pharmacist.
        const val = v => (v == null ? null : v);
        const rec = {};
        if (stable(val(o && o.a)) !== stable(val(n && n.a))) rec.a = (n && n.a) || null;
        if (stable(val(o && o.t)) !== stable(val(n && n.t))) rec.t = (n && n.t) || null;
        if ((o && o.s || '') !== (n && n.s || '')) rec.s = (n && n.s) || '';
        if (Object.keys(rec).length) records[id] = rec;
      } else if (n === undefined) {
        records[id] = null;
      } else if (stable(o) !== stable(n)) {
        records[id] = n;
      }
    });
    const skeys = new Set([...Object.keys(newC.settings), ...(allowDelete ? Object.keys(oldC.settings) : [])]);
    skeys.forEach(k => {
      if (stable(oldC.settings[k]) !== stable(newC.settings[k])) settings[k] = newC.settings[k] === undefined ? null : newC.settings[k];
    });
    return { records, settings };
  }

  /* ───────────── getShared / setShared (same interface as before) ───────────── */
  const snapshots = {};
  let lastLoadErrorAt = 0;

  window.getShared = async function (key, fallback) {
    try {
      const out = await API.call('get', { key });
      const canon = canonFromWire(key, out.data || {});
      snapshots[key] = canon;
      return valueFromCanon(key, canon);
    } catch (e) {
      console.error('load failed', key, e);
      if (!e.authExpired && Date.now() - lastLoadErrorAt > 4000 && typeof toast === 'function') {
        lastLoadErrorAt = Date.now();
        toast('Could not load data — ' + (e.message || 'check your connection'), 'err');
      }
      return fallback;
    }
  };

  /** Loads several keys in ONE request (one round-trip instead of several). Falls back to one-by-one
      loading if the deployed backend is an older version that doesn't know "getMany". */
  window.getSharedMany = async function (keys, fallbacks) {
    fallbacks = fallbacks || {};
    try {
      const out = await API.call('getMany', { keys });
      const res = {};
      keys.forEach(k => {
        const canon = canonFromWire(k, (out.data || {})[k] || {});
        snapshots[k] = canon;
        res[k] = valueFromCanon(k, canon);
      });
      return res;
    } catch (e) {
      if (/unknown action/i.test(e.message || '')) {
        const res = {};
        for (const k of keys) res[k] = await window.getShared(k, fallbacks[k]);   // sequential, not parallel
        return res;
      }
      console.error('load failed', keys, e);
      if (!e.authExpired && typeof toast === 'function') toast('Could not load data — ' + (e.message || 'check your connection'), 'err');
      const res = {};
      keys.forEach(k => { res[k] = fallbacks[k]; });
      return res;
    }
  };

  window.setShared = async function (key, value) {
    try {
      const newC = canonFromValue(key, value);
      const hadSnapshot = !!snapshots[key];
      const oldC = snapshots[key] || emptyCanon();
      // Without a prior read we cannot tell what was deleted, so we only ever add/update in that case.
      const patch = diffCanon(key, oldC, newC, hadSnapshot);
      if (!Object.keys(patch.records).length && !Object.keys(patch.settings).length) return true;
      const out = await API.call('patch', { key, records: patch.records, settings: patch.settings });
      snapshots[key] = newC;
      if (key === 'operations' && out && out.ops) applyServerOps(value, out.ops, newC);
      flashSaved();
      return true;
    } catch (e) {
      console.error('storage save failed', key, e);
      if (typeof toast === 'function') toast('Save failed — ' + (e.message || 'please try again'), 'err');
      if (APP_HOOKS.onSaveFailed && !e.authExpired) APP_HOOKS.onSaveFailed(key, e);
      return false;
    }
  };

  /* After a date change the server returns what it actually stored for those pharmacists — the assignment (with its
     "Retraining #n" marker and the signed-in "assigned by") and the attempt history — so the page shows it straight
     away without a reload. The page re-renders through APP_HOOKS.onOpsUpdated. */
  function applyServerOps(value, rows, sent) {
    const snap = snapshots.operations;
    let historyChanged = false;
    Object.keys(rows).forEach(pid => {
      const r = rows[pid] || {};
      if (!value.history) value.history = {};
      const before = stable(value.history[pid] || []);
      // Only replace the assignment on the page if nobody changed it again while this save was on its way —
      // otherwise the newer choice stays and the next save sends it (the snapshot below holds the server's version).
      const sentA = sent.records[pid] && sent.records[pid].a;
      if (stable(value.assignments[pid] || null) === stable(sentA || null)) {
        if (r.a) value.assignments[pid] = clone(r.a); else delete value.assignments[pid];
      }
      if (r.h && r.h.length) value.history[pid] = clone(r.h); else delete value.history[pid];
      if (before !== stable(value.history[pid] || [])) historyChanged = true;
      if (snap) {
        if (!snap.records[pid]) { snap.records[pid] = {}; snap.order.push(pid); }
        const s = snap.records[pid];
        if (r.a) s.a = clone(r.a); else delete s.a;
        if (r.h && r.h.length) s.h = clone(r.h); else delete s.h;
      }
    });
    if (APP_HOOKS.onOpsUpdated) { try { APP_HOOKS.onOpsUpdated(Object.keys(rows), historyChanged); } catch (e) { console.error(e); } }
  }

  /** Value as of the last read of this key (used for undo history without refreshing the snapshot). */
  window.peekSnapshot = function (key) {
    return snapshots[key] ? valueFromCanon(key, snapshots[key]) : null;
  };

  /* Per-browser conveniences (last supervisor picked, etc.) */
  window.getPersonal = async function (key, fallback) {
    try { const r = localStorage.getItem('upc:' + key); return r ? JSON.parse(r) : fallback; } catch (e) { return fallback; }
  };
  window.setPersonal = async function (key, value) {
    try { localStorage.setItem('upc:' + key, JSON.stringify(value)); } catch (e) {}
  };
})();
