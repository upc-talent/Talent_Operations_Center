/* ════════════════════════════════════════════════════════════════════
   DEV ONLY — runs the REAL backend/Code.gs against a fake in-memory spreadsheet.
   Open any page with  ?mock=1  (and ?mock=0 to switch back to the live backend).
   The data is synthetic (no real people) and lives in this browser's localStorage.
   Sign in on the trainer page with   demo / demo
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const STORE_KEY = 'upc_mock_sheet_v1';

  /* ───────────── synchronous SHA-256 / HMAC (Apps Script's Utilities is synchronous) ───────────── */
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256(bytes) {
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const l = bytes.length, withPad = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    withPad.set(bytes); withPad[l] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, (l * 8) >>> 0); dv.setUint32(withPad.length - 8, Math.floor(l / 0x20000000));
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3), s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
    }
    const out = new Uint8Array(32), o = new DataView(out.buffer);
    H.forEach((v, i) => o.setUint32(i * 4, v));
    return out;
  }
  function hmac(keyBytes, msgBytes) {
    let k = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes;
    const kp = new Uint8Array(64); kp.set(k);
    const ipad = kp.map(b => b ^ 0x36), opad = kp.map(b => b ^ 0x5c);
    const inner = sha256(Uint8Array.from([...ipad, ...msgBytes]));
    return sha256(Uint8Array.from([...opad, ...inner]));
  }
  const enc = s => new TextEncoder().encode(s);
  const toBytes = x => (typeof x === 'string' ? enc(x) : Uint8Array.from(x));
  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const webSafe = s => s.replace(/\+/g, '-').replace(/\//g, '_');

  /* ───────────── fake Google services ───────────── */
  function makeSheet(state) {
    const sh = {
      _s: state,
      getName: () => state.name,
      getMaxRows: () => state.maxRows,
      getMaxColumns: () => state.maxCols,
      getLastColumn() { let lc = 0; state.rows.forEach(r => { for (let c = (r || []).length; c > 0; c--) if (r[c-1] !== '' && r[c-1] != null) { lc = Math.max(lc, c); break; } }); return lc; },
      getLastRow() { for (let r = state.rows.length - 1; r >= 0; r--) if ((state.rows[r] || []).some(v => v !== '' && v != null)) return r + 1; return 0; },
      insertRowsAfter(pos, n) { for (let i = 0; i < n; i++) state.rows.splice(pos, 0, []); state.maxRows += n; },
      insertColumnsAfter(pos, n) { state.maxCols += n; },
      deleteRows(start, n) { state.rows.splice(start - 1, n); state.maxRows -= n; },
      hideColumns() {}, setFrozenRows() {},
      getDataRange() { const lr = sh.getLastRow(); let lc = 0; state.rows.forEach(r => { for (let c = (r || []).length; c > 0; c--) if (r[c-1] !== '' && r[c-1] != null) { lc = Math.max(lc, c); break; } }); return sh.getRange(1, 1, Math.max(lr, 1), Math.max(lc, 1)); },
      setValue(v) { return sh.getRange(1, 1).setValue(v); },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        if (r < 1 || c < 1 || r + nr - 1 > state.maxRows || c + nc - 1 > state.maxCols) throw new Error('The coordinates or dimensions of the range are invalid. (' + state.name + ' r' + r + ' c' + c + ' ' + nr + 'x' + nc + ')');
        const rng = {
          getValues() { return rng.getDisplayValues(); },
          getDisplayValues() { const out = []; for (let i = 0; i < nr; i++) { const row = state.rows[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v == null ? '' : String(v)); } out.push(o); } return out; },
          getValue() { return rng.getDisplayValues()[0][0]; },
          setValues(vals) {
            if (vals.length !== nr || (vals[0] || []).length !== nc) throw new Error('The number of rows/columns in the data does not match the range (' + vals.length + 'x' + (vals[0]||[]).length + ' vs ' + nr + 'x' + nc + ')');
            for (let i = 0; i < nr; i++) { const rr = state.rows[r - 1 + i] || (state.rows[r - 1 + i] = []); for (let j = 0; j < nc; j++) rr[c - 1 + j] = vals[i][j] == null ? '' : String(vals[i][j]); }
            return rng;
          },
          setValue(v) { const g = []; for (let i = 0; i < nr; i++) g.push(new Array(nc).fill(v)); return rng.setValues(g); },
          setNumberFormat() { return rng; }, setFontWeight() { return rng; }, setBackground() { return rng; }, setFontColor() { return rng; }, copyTo() { return rng; }
        };
        return rng;
      }
    };
    return sh;
  }

  function makeEnv(store) {
    const sheets = {};
    const ss = {
      getSheetByName: n => (store.sheets[n] ? (sheets[n] || (sheets[n] = makeSheet(store.sheets[n]))) : null),
      insertSheet(n) { store.sheets[n] = { name: n, rows: [], maxRows: 1000, maxCols: 26 }; return ss.getSheetByName(n); },
      getSheets: () => Object.keys(store.sheets).map(n => ss.getSheetByName(n))
    };
    const cache = {};
    const props = store.props;
    return {
      SpreadsheetApp: { openById: () => ss, flush() {}, CopyPasteType: { PASTE_FORMAT: 1 } },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      CacheService: { getScriptCache: () => ({
        get: k => { const e = cache[k]; if (!e) return null; if (e.exp < Date.now()) { delete cache[k]; return null; } return e.v; },
        put: (k, v, ttl) => { cache[k] = { v, exp: Date.now() + (ttl || 60) * 1000 }; },
        remove: k => { delete cache[k]; } }) },
      PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
      Utilities: {
        getUuid: () => crypto.randomUUID(),
        sleep() {},
        computeHmacSha256Signature: (msg, key) => Array.from(hmac(toBytes(key), toBytes(msg))),
        base64EncodeWebSafe: x => webSafe(b64(toBytes(x))),
        base64DecodeWebSafe: s => Array.from(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))),
        newBlob: bytes => ({ getDataAsString: () => new TextDecoder().decode(Uint8Array.from(bytes)) })
      },
      ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ getContent: () => t, setMimeType() { return this; } }) },
      Logger: { log: (...a) => console.log('[GAS]', ...a) }
    };
  }

  /* ───────────── synthetic data ───────────── */
  function seed(store) {
    const HC = { name: 'HeadCount', rows: [], maxRows: 400, maxCols: 15 };
    // same shape as the real sheet after a column was inserted: Attendance Adherence in M, Notes in N, and an
    // earlier build's pharmacist ids sitting in column O with no header
    HC.rows.push(['District','Area Manager','City','Supervisor Name','Date','Pharmacy No.','User/Employee ID','Username (Email)','Display Name (Pharmacist name)','Phone number (Whatsapp)','SCFHS','Attendance Status','Attendance Adherence','Notes','']);
    const cities = [
      ['Dr. Test East', 'Dr. Area One', 'Jeddah North', ['Dr. Sara Demo', 'Dr. Omar Demo']],
      ['Dr. Test East', 'Dr. Area One', 'Jeddah South', ['Dr. Lina Demo']],
      ['Dr. Test Central', 'Dr. Area Two', 'Riyadh', ['Dr. Karim Demo', 'Dr. Noor Demo']],
      ['Dr. Test West', 'Dr. Area Three', 'Mecca', ['Dr. Yara Demo']],
      ['Dr. Test West', 'Dr. Area Three', 'Online', ['Dr. Sara Demo', 'Dr. Karim Demo']]
    ];
    const first = ['Adam','Bassem','Carla','Dina','Emad','Farah','Gamal','Hana','Iyad','Jana','Khaled','Layla','Mazen','Nada','Osama','Rana','Sami','Tala'];
    let n = 0;
    cities.forEach(([district, am, city, sups]) => {
      sups.forEach(sup => {
        for (let i = 0; i < 6; i++) {
          n++;
          const nm = first[n % first.length] + ' Sample ' + n;
          HC.rows.push([district, am, city, sup, '', 'P' + (100 + n), String(1000 + n), 'demo_user' + n + '@example.test', nm, '5' + String(10000000 + n), i % 2 ? 'SC' + (200000 + n) : '-', '', '', n === 3 ? 'Legal issue abroad - check with HR before assigning' : '', 'ph_seed' + n]);
        }
      });
    });
    HC.rows.push(['Dr. Test East', 'Dr. Area One', 'Supervisors', '-', '', '-', '955', 'sup_lead@example.test', 'Lead Supervisor Sample', '500000000', '-', '', '', '', 'ph_seedlead']);
    store.sheets.HeadCount = HC;

    // a small weekly grid in the same layout as the real calendar tab
    const g = [];
    const row = () => new Array(20).fill('');
    let r = row(); r[1] = '2026 - Q4 Operation Training Calendar'; g.push(r);
    const week = (dates, codes, trainers) => {
      const d = row(), c = row(), t = row();
      dates.forEach((dt, i) => { d[1 + i * 4] = dt; });
      codes.forEach((cs, i) => cs.forEach((code, j) => { c[1 + i * 4 + j] = code; }));
      trainers.forEach((ts, i) => ts.forEach((tn, j) => { t[1 + i * 4 + j] = tn; }));
      g.push(d, c, t);
    };
    week(['Mon 5 Oct', 'Tue 6 Oct', 'Wed 7 Oct'], [['JED N 1', 'MIX 2', 'MIX 3'], ['JED S 1', 'MIX 2', 'MIX 3'], ['RUH 1']], [['Amjad', 'EG', 'EG'], ['Omar', 'EG', 'EG'], ['Amr']]);
    week(['Mon 12 Oct', 'Tue 13 Oct'], [['MEC 1', 'MIX 4'], ['RUH 2']], [['Hennawi', 'EG'], ['Amjad']]);
    store.sheets['2026 - Q4 Training Calendar'] = { name: '2026 - Q4 Training Calendar', rows: g, maxRows: 100, maxCols: 20 };

    store.sheets.Venues = { name: 'Venues', rows: [
      ['', '', '', ''], ['', 'City', 'Recommended Venues', ''],
      ['', 'Jeddah', 'Demo Hotel Jeddah', ''], ['', 'Riyadh', 'Demo Hotel Riyadh', ''], ['', 'Mecca', 'Demo Hotel Mecca', '']
    ], maxRows: 50, maxCols: 6 };
    store.props.TRAINER_USER = 'demo';
    store.props.TRAINER_PASS = 'demo';
  }

  /* ───────────── glue ───────────── */
  let gs = null, store = null, booting = null;
  function persist() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {} }

  async function boot() {
    const src = await (await fetch((window.APP_CONFIG && APP_CONFIG.BASE || '') + 'backend/Code.gs')).text();
    try { store = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { store = null; }
    const fresh = !store;
    if (fresh) { store = { sheets: {}, props: {} }; seed(store); }
    const env = makeEnv(store);
    const names = Object.keys(env);
    // wrapped in a function so Code.gs' top-level names never collide with the page's own globals
    gs = new Function(...names, src + '\n;return {doPost:doPost,doGet:doGet,setupSheets:setupSheets,checkSetup:checkSetup};')(...names.map(n => env[n]));
    if (fresh) { gs.setupSheets(); persist(); }
  }

  window.MockBackend = {
    async handle(body) {
      if (!booting) booting = boot();
      await booting;
      await new Promise(r => setTimeout(r, 120));   // feel like a network call
      const out = gs.doPost({ postData: { contents: JSON.stringify(body) } });
      persist();
      return JSON.parse(out.getContent());
    },
    setup() { gs.setupSheets(); persist(); },   // same as pressing Run on setupSheets in the Apps Script editor
    reset() { localStorage.removeItem(STORE_KEY); location.reload(); },
    dump() { return store; }
  };
})();
