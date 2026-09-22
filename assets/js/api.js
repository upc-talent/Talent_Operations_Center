/* ════════════════════════════════════════════════════════════════════
   Backend client + storage adapter
   ------------------------------------------------------------------
   The app code was written against a tiny key/value store
   (getShared / setShared). This file keeps that interface but talks to
   the Google Apps Script backend, and — importantly — sends only the
   RECORDS THAT CHANGED (a diff against what this page last read), so two
   people saving different rows at the same time no longer overwrite each other.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const CFG = window.APP_CONFIG || {};
  const TOKEN_KEY = 'upc_trainer_token';

  const APP_HOOKS = { onAuthExpired: null, onSaveFailed: null };
  window.APP_HOOKS = APP_HOOKS;

  /* ───────────── transport ───────────── */
  let mockLoading = null;
  function loadMock() {
    if (window.MockBackend) return Promise.resolve();
    if (!mockLoading) {
      mockLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = (CFG.BASE || '') + 'dev/mock-backend.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load the dev mock backend'));
        document.head.appendChild(s);
      });
    }
    return mockLoading;
  }

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

  // One attempt. Anything that looks like a temporary Google / network hiccup is flagged `transient` so it can be retried.
  async function transportOnce(body) {
    if (!CFG.API_URL) throw new Error('Backend URL is not configured (assets/js/config.js).');
    let res;
    try {
      // Plain-text body keeps this a "simple" request, so Apps Script needs no CORS pre-flight.
      res = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
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
      const err = new Error('Google returned an unexpected page');   // an HTML error page instead of JSON
      err.transient = true;
      throw err;
    }
  }

  // Google Apps Script occasionally answers a perfectly good request with a 404 / 5xx / HTML page, mostly when
  // several requests hit at once. Every request here is safe to repeat (writes are per-record upserts/deletes),
  // so temporary failures are retried a couple of times before the user ever sees an error.
  async function transport(body) {
    const isWrite = body.action === 'patch';
    if (isWrite) pendingWrites++; else pendingReads++;
    emitStatus();
    try {
      if (CFG.API_URL === 'mock') {
        await loadMock();
        return await window.MockBackend.handle(body);
      }
      const waits = [700, 1800];
      for (let attempt = 0; ; attempt++) {
        try {
          return await transportOnce(body);
        } catch (e) {
          if (!e.transient || attempt >= waits.length) throw e;
          await sleep(waits[attempt]);
        }
      }
    } finally {
      if (isWrite) pendingWrites--; else pendingReads--;
      emitStatus();
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

    async call(action, extra) {
      const body = Object.assign({ action }, extra || {});
      if (API.mode === 'trainer') {
        let tok = null;
        try { tok = sessionStorage.getItem(TOKEN_KEY); } catch (e) {}
        if (tok) body.token = tok;
      } else if (API.supervisor) {
        body.supervisor = API.supervisor;
      }
      const out = await transport(body);
      if (!out || out.ok === false) {
        const err = new Error((out && out.error) || 'Request failed');
        if (/sign in again|Trainer login required|Not authorised/i.test(err.message) && API.mode === 'trainer') {
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
      return true;
    },
    logout() { API.clearToken(); },
    async verifySession() {
      if (!API.hasToken()) return false;
      try { await API.call('me'); return true; } catch (e) { return false; }
    },

    async supervisorNames() { return (await API.call('supervisors')).names || []; },
    async calendarGrid() { return (await API.call('calendarGrid')).values || []; },
    async syncCalendar() { return (await API.call('syncCalendar')).summary || {}; },
    async venues() { return (await API.call('venues')).venues || []; }
  };
  window.API = API;

  /* ───────────── canonical form + diff ───────────── */
  const ARRAY_KEYS = ['master-pharmacists', 'pending-pharmacists', 'leave-requests', 'quota-approval-history', 'pharmacist-notifications'];
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
      const out = { assignments: {}, attendance: {} };
      c.order.forEach(pid => {
        const r = c.records[pid] || {};
        if (r.a) out.assignments[pid] = clone(r.a);
        if (r.t) out.attendance[pid] = clone(r.t);
      });
      return out;
    }
    if (key === 'training-config') {
      const cfg = clone(c.settings) || {};
      cfg.dates = c.order.map(id => clone(c.records[id]));
      return cfg;
    }
    if (key === 'company-logo') return c.settings.logo === undefined ? null : c.settings.logo;
    return null;
  }

  function canonFromValue(key, value) {
    const c = emptyCanon();
    if (ARRAY_KEYS.includes(key)) {
      (value || []).forEach(item => { c.records[item.id] = clone(item); c.order.push(item.id); });
    } else if (key === 'operations') {
      const asg = (value && value.assignments) || {}, att = (value && value.attendance) || {};
      new Set([...Object.keys(asg), ...Object.keys(att)]).forEach(pid => {
        const r = {};
        if (asg[pid]) r.a = clone(asg[pid]);
        if (att[pid]) r.t = clone(att[pid]);
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
        const rec = {};
        if (stable(o && o.a) !== stable(n && n.a)) rec.a = (n && n.a) || null;
        if (stable(o && o.t) !== stable(n && n.t)) rec.t = (n && n.t) || null;
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

  /** Loads several keys in ONE request (much lighter on Google than parallel requests). Falls back to one-by-one
      loading if the deployed script is an older version that doesn't know "getMany". */
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
      await API.call('patch', { key, records: patch.records, settings: patch.settings });
      snapshots[key] = newC;
      flashSaved();
      return true;
    } catch (e) {
      console.error('storage save failed', key, e);
      if (typeof toast === 'function') toast('Save failed — ' + (e.message || 'please try again'), 'err');
      if (APP_HOOKS.onSaveFailed && !e.authExpired) APP_HOOKS.onSaveFailed(key, e);
      return false;
    }
  };

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
