/**
 * Training Operations Hub — Google Apps Script backend
 * ----------------------------------------------------
 * Deploy as a Web App:  Execute as = Me,  Who has access = Anyone.
 * The Google Sheet itself should stay RESTRICTED (not "anyone with the link") —
 * this script runs as the sheet owner, so the app never needs the sheet to be public.
 *
 * Trainer credentials are NOT in this file. Set them once in
 *   Project Settings > Script Properties:   TRAINER_USER   and   TRAINER_PASS
 *
 * Run setupSheets() once from the editor (see README) before first use.
 */

var CONFIG = {
  SPREADSHEET_ID: '1WPFKNeJlbAevuRL7DmKqhMWu4cynUoY7Tjp7mAIhK8U',
  TABS: {
    HEADCOUNT: 'HeadCount',
    CALENDAR:  '2026 - Q4 Training Calendar',
    VENUES:    'Venues',
    APPROVALS: 'Approvals',
    DAYS:      'TrainingDays',
    NOTIFS:    'Notifications',
    SETTINGS:  'Settings'
  },
  TOKEN_TTL_HOURS: 10,
  MAX_LOGIN_FAILS: 8,
  LOCKOUT_MINUTES: 10,
  DEFAULT_CAPACITY: 30
};

/* HeadCount columns are found by their HEADER TEXT (row 1), never by position — so you can insert, move or
 * rename-around columns freely. HC.X is the 1-based column number of field X, filled in by initHCLayout_().
 * Columns the app needs but the sheet lacks (e.g. "Pharmacist ID", "Session") are added at the right-hand end. */
var HC = {};
var HC_LAYOUT_DONE = false;
var HC_FIELDS = [
  // [key, accepted header texts (lower-case), header written if the app has to add the column]
  ['DISTRICT',   ['district']],
  ['AREA',       ['area manager']],
  ['CITY',       ['city']],
  ['SUPERVISOR', ['supervisor name', 'supervisor']],
  ['DATE',       ['date']],
  ['PHARMACY',   ['pharmacy no.', 'pharmacy no']],
  ['EMPID',      ['user/employee id', 'employee id']],
  ['EMAIL',      ['username (email)', 'email']],
  ['NAME',       ['display name (pharmacist name)', 'display name']],
  ['PHONE',      ['phone number (whatsapp)', 'phone number', 'phone']],
  ['SCFHS',      ['scfhs']],
  ['STATUS',     ['attendance status']],
  ['ADHERENCE',  ['attendance adherence'], 'Attendance Adherence'],
  ['NOTES',      ['notes', 'note'], 'Notes'],
  ['ID',         ['pharmacist id'], 'Pharmacist ID'],
  ['SESSION',    ['session'], 'Session'],
  ['ARRIVAL',    ['arrival time'], 'Arrival Time'],
  ['COMPLETION', ['completion %', 'completion'], 'Completion %'],
  ['ASSIGN',     ['assignment (system)'], 'Assignment (system)'],
  ['ATT',        ['attendance (system)'], 'Attendance (system)']
];
var HC_REQUIRED = ['DISTRICT', 'AREA', 'CITY', 'SUPERVISOR', 'DATE', 'EMAIL', 'NAME'];
var ID_RE = /^ph_[a-z0-9]+$/i;
var LEAVE_STATUSES = ['Sick Leave', 'Annual Leave', 'Resignation', 'Promotion'];
var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* ═════════════════════════ HTTP entry points ═════════════════════════ */

function doGet() {
  // Health check only — no data is ever served over GET.
  return json_({ ok: true, service: 'Training Operations Hub API' });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  var action = req.action;
  if (action === 'login') return login_(req);
  if (action === 'supervisors') return { ok: true, names: supervisorNames_() };
  // the company logo is shown on every page (before anyone picks a name or signs in) and is not sensitive
  if (action === 'get' && req.key === 'company-logo') return { ok: true, data: getKey_({ role: 'public' }, 'company-logo') };
  var ctx = authenticate_(req);
  switch (action) {
    case 'me':           return { ok: true, role: ctx.role, who: ctx.who || null };
    case 'get':          return { ok: true, data: getKey_(ctx, req.key) };
    case 'patch':        return patchKey_(ctx, req);
    case 'calendarGrid': requireTrainer_(ctx); return { ok: true, values: calendarGrid_() };
    case 'syncCalendar': requireTrainer_(ctx); return { ok: true, summary: syncCalendar_(true) };
    case 'venues':       requireTrainer_(ctx); return { ok: true, venues: venues_() };
  }
  throw new Error('Unknown action');
}

/* ═════════════════════════ Auth ═════════════════════════ */

function requireTrainer_(ctx) {
  if (ctx.role !== 'trainer') throw new Error('Trainer login required.');
}

function authenticate_(req) {
  if (req.token) {
    var p = verifyToken_(req.token);
    if (!p) throw new Error('Session expired — please sign in again.');
    return { role: 'trainer', user: p.u };
  }
  if (req.supervisor) {
    var names = supervisorNames_();
    if (names.indexOf(String(req.supervisor)) === -1) throw new Error('Unknown supervisor.');
    return { role: 'supervisor', who: String(req.supervisor) };
  }
  throw new Error('Not authorised.');
}

function safeEq_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}

function makeToken_(user) {
  var exp = Date.now() + CONFIG.TOKEN_TTL_HOURS * 3600 * 1000;
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify({ u: user, e: exp }));
  return payload + '.' + sign_(payload);
}

function verifyToken_(tok) {
  if (!tok || typeof tok !== 'string') return null;
  var parts = tok.split('.');
  if (parts.length !== 2) return null;
  if (!safeEq_(sign_(parts[0]), parts[1])) return null;
  var p;
  try {
    p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (e) { return null; }
  if (!p || !p.e || Date.now() > p.e) return null;
  return p;
}

function login_(req) {
  var props = PropertiesService.getScriptProperties();
  var user = props.getProperty('TRAINER_USER');
  var pass = props.getProperty('TRAINER_PASS');
  if (!user || !pass) throw new Error('Trainer credentials are not configured on the server (Script Properties).');
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('login_fails') || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS) throw new Error('Too many failed attempts. Please try again in a few minutes.');
  var ok = safeEq_(String(req.username || ''), user) & safeEq_(String(req.password || ''), pass);
  if (!ok) {
    cache.put('login_fails', String(fails + 1), CONFIG.LOCKOUT_MINUTES * 60);
    Utilities.sleep(1000);
    throw new Error('Invalid username or password.');
  }
  cache.remove('login_fails');
  return { ok: true, token: makeToken_(user), ttlHours: CONFIG.TOKEN_TTL_HOURS };
}

/* ═════════════════════════ Sheet helpers ═════════════════════════ */

var _ss = null;
function ss_() {
  if (!_ss) _ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  return _ss;
}
function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet tab: "' + name + '" — run setupSheets().');
  return sh;
}
function parseJson_(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function nowIso_() { return new Date().toISOString(); }

/** Works out where each HeadCount field lives from the header row, and adds any column the app needs but the sheet lacks. */
function initHCLayout_(sh) {
  if (HC_LAYOUT_DONE) return;
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var layout = {}, used = {};
  HC_FIELDS.forEach(function (f) {
    for (var i = 0; i < header.length; i++) {
      if (!used[i] && f[1].indexOf(header[i]) !== -1) { layout[f[0]] = i + 1; used[i] = true; return; }
    }
  });
  HC_FIELDS.forEach(function (f) {
    if (HC_REQUIRED.indexOf(f[0]) !== -1 && !layout[f[0]]) throw new Error('The HeadCount tab needs a column headed "' + f[1][0] + '" in row 1.');
  });

  // A column of app-generated ids that lost its header (e.g. after a column was inserted) is adopted as "Pharmacist ID".
  if (!layout.ID && sh.getLastRow() >= 2) {
    for (var c = 0; c < header.length; c++) {
      if (used[c] || header[c] !== '') continue;
      var vals = sh.getRange(2, c + 1, sh.getLastRow() - 1, 1).getDisplayValues();
      var filled = 0, ids = 0;
      vals.forEach(function (x) { if (x[0] !== '') { filled++; if (ID_RE.test(x[0])) ids++; } });
      if (filled > 0 && ids / filled > 0.5) {
        layout.ID = c + 1; used[c] = true;
        sh.getRange(1, c + 1).setNumberFormat('@').setValue('Pharmacist ID');
        break;
      }
    }
  }

  // Likewise adopt unlabelled columns holding the app's saved assignments / attendance (written by an earlier build
  // into whatever column sat in that position), so nothing already recorded is lost.
  if ((!layout.ASSIGN || !layout.ATT) && sh.getLastRow() >= 2) {
    for (var c2 = 0; c2 < header.length; c2++) {
      if (used[c2] || header[c2] !== '') continue;
      var col = sh.getRange(2, c2 + 1, sh.getLastRow() - 1, 1).getDisplayValues();
      var nonEmpty = 0, asg = 0, att = 0;
      col.forEach(function (x) {
        var s = String(x[0]);
        if (s === '') return;
        nonEmpty++;
        if (/^\{"type":"(date|leave)"/.test(s)) asg++;
        else if (/^\{/.test(s) && /"(status|day1|day2|note|markedAt)"/.test(s)) att++;
      });
      if (!nonEmpty) continue;
      if (!layout.ASSIGN && asg / nonEmpty > 0.5) {
        layout.ASSIGN = c2 + 1; used[c2] = true; sh.getRange(1, c2 + 1).setNumberFormat('@').setValue('Assignment (system)');
      } else if (!layout.ATT && att / nonEmpty > 0.5) {
        layout.ATT = c2 + 1; used[c2] = true; sh.getRange(1, c2 + 1).setNumberFormat('@').setValue('Attendance (system)');
      }
    }
  }

  var next = lastCol;
  HC_FIELDS.forEach(function (f) {
    if (layout[f[0]] || !f[2]) return;
    next++;
    layout[f[0]] = next;
    if (sh.getMaxColumns() < next) sh.insertColumnsAfter(sh.getMaxColumns(), next - sh.getMaxColumns());
    sh.getRange(1, next).setNumberFormat('@').setValue(f[2]);
  });
  layout.NCOLS = Math.max(next, lastCol);
  HC = layout;
  HC_LAYOUT_DONE = true;
}

/** Reads HeadCount into [{row, v:[display strings]}]. Gives every pharmacist an ID and repairs ids that ended up in the wrong column. */
function readHC_() {
  var sh = sheet_(CONFIG.TABS.HEADCOUNT);
  initHCLayout_(sh);
  var last = sh.getLastRow();
  var rows = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, HC.NCOLS).getDisplayValues();
    var seen = {}, idFix = {}, noteFix = false;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (!String(v[HC.NAME - 1]).trim()) continue;
      var id = String(v[HC.ID - 1]).trim();
      var note = String(v[HC.NOTES - 1]).trim();
      // an earlier build wrote ids into the Notes column when a column had been inserted: put them back
      if (ID_RE.test(note)) {
        if (!ID_RE.test(id)) id = note;
        v[HC.NOTES - 1] = '';
        noteFix = true;
      }
      if (!ID_RE.test(id) || seen[id]) {          // blank, overwritten by something else, or duplicated
        id = newId_('ph', seen);
      }
      if (id !== String(v[HC.ID - 1]).trim()) idFix[i] = id;
      seen[id] = true;
      v[HC.ID - 1] = id;
      rows.push({ row: i + 2, v: v });
    }
    if (Object.keys(idFix).length) {
      var idCol = sh.getRange(2, HC.ID, last - 1, 1);
      var idVals = idCol.getDisplayValues();
      Object.keys(idFix).forEach(function (k) { idVals[k][0] = idFix[k]; });
      idCol.setNumberFormat('@').setValues(idVals);
    }
    if (noteFix) {
      var noteCol = sh.getRange(2, HC.NOTES, last - 1, 1);
      var noteVals = noteCol.getDisplayValues();
      for (var j = 0; j < noteVals.length; j++) if (ID_RE.test(String(noteVals[j][0]).trim())) noteVals[j][0] = '';
      noteCol.setNumberFormat('@').setValues(noteVals);
    }
  }
  return { sh: sh, rows: rows };
}

function newId_(prefix, taken) {
  var id;
  do { id = prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); } while (taken && taken[id]);
  return id;
}

function supervisorNames_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('sup_names');
  if (hit) return JSON.parse(hit);
  var hc = readHC_();
  var seen = {}, out = [];
  hc.rows.forEach(function (r) {
    var n = String(r.v[HC.SUPERVISOR - 1]).trim();
    if (n && n !== '-' && n !== '—' && !seen[n]) { seen[n] = true; out.push(n); }
  });
  out.sort();
  cache.put('sup_names', JSON.stringify(out), 300);
  return out;
}

/** Writes cells. updates = [{row, cols:{colIndex:value}}]. All values are written as text. */
function writeCells_(sh, updates) {
  if (!updates.length) return;
  if (updates.length <= 25) {
    updates.forEach(function (u) {
      var cols = Object.keys(u.cols).map(Number).sort(function (a, b) { return a - b; });
      var i = 0;
      while (i < cols.length) {
        var j = i;
        while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
        var vals = [];
        for (var c = cols[i]; c <= cols[j]; c++) vals.push(String(u.cols[c] == null ? '' : u.cols[c]));
        sh.getRange(u.row, cols[i], 1, vals.length).setNumberFormat('@').setValues([vals]);
        i = j + 1;
      }
    });
    return;
  }
  // bulk: rewrite whole columns in one call each
  var last = sh.getLastRow();
  var colSet = {};
  updates.forEach(function (u) { Object.keys(u.cols).forEach(function (c) { colSet[c] = true; }); });
  Object.keys(colSet).forEach(function (c) {
    c = Number(c);
    var rng = sh.getRange(2, c, last - 1, 1);
    var vals = rng.getDisplayValues();
    updates.forEach(function (u) {
      if (u.cols.hasOwnProperty(c)) vals[u.row - 2][0] = String(u.cols[c] == null ? '' : u.cols[c]);
    });
    rng.setNumberFormat('@').setValues(vals);
  });
}

/** Deletes rows (1-based numbers) bottom-up in consecutive runs. */
function deleteRows_(sh, rowNums) {
  if (!rowNums.length) return;
  var rows = rowNums.slice().sort(function (a, b) { return b - a; });
  if (rows[0] >= sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1); // never delete every non-frozen row
  var i = 0;
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], j - i + 1);
    i = j + 1;
  }
}

function appendRows_(sh, ncols, rows) {
  if (!rows.length) return;
  var start = sh.getLastRow() + 1;
  var needed = start + rows.length - 1;
  if (needed > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows());
  sh.getRange(start, 1, rows.length, ncols).setNumberFormat('@').setValues(rows);
}

/* ═════════════════════════ Dates & attendance helpers ═════════════════════════ */

function parseIso_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}
function fmtDate_(iso) {
  var p = parseIso_(iso);
  if (!p) return String(iso || '');
  return p.d + ' ' + MONTHS[p.m] + ' ' + String(p.y).slice(-2);
}
/** Same wording as dayDateLabel() in the front end. */
function dayLabel_(day) {
  if (!day || !day.date) return '';
  if (!(day.isOnline && day.onlineFormat === 'split')) return fmtDate_(day.date);
  var p = parseIso_(day.date);
  if (!p) return fmtDate_(day.date);
  var dt = new Date(Date.UTC(p.y, p.m, p.d + 1));
  var m2 = dt.getUTCMonth(), d2 = dt.getUTCDate(), yy = String(p.y).slice(-2);
  if (p.m === m2) return p.d + ' - ' + d2 + ' ' + MONTHS[p.m] + ' ' + yy;
  return p.d + ' ' + MONTHS[p.m] + ' - ' + d2 + ' ' + MONTHS[m2] + ' ' + yy;
}
function isSplit_(day) { return !!(day && day.isOnline && day.onlineFormat === 'split'); }

function attStatus_(t, split) {
  if (!t) return '';
  if (split) {
    var s1 = t.day1 && t.day1.status, s2 = t.day2 && t.day2.status;
    if (s1 === 'Attended' && s2 === 'Attended') return 'Attended';
    if (s1 === 'Absent' && s2 === 'Absent') return 'Absent';
    if (!s1 && !s2) return '';
    return 'Partial (Day ' + (s1 === 'Attended' ? 2 : 1) + ' missing)';
  }
  return t.status || '';
}

/** Human-readable columns (Date, Attendance Status, Attendance Adherence, Session, Arrival Time) + the system JSON columns for one pharmacist row. */
function derivedCols_(a, t, days) {
  var cols = {};
  cols[HC.ASSIGN] = a ? JSON.stringify(a) : '';
  cols[HC.ATT] = t ? JSON.stringify(t) : '';
  var date = '', session = '', status = '', adherence = '', arrival = '';
  if (a && a.type === 'leave') {
    date = a.status; session = a.status; status = a.status;
  } else if (a && a.type === 'date') {
    var day = days[a.dateId];
    if (day) {
      var label = dayLabel_(day);
      var pending = a.overQuota && !a.quotaApproved;
      session = (pending ? 'Pending quota approval — ' : '') + day.city + ' — ' + label;
      if (!pending) date = label;
      var split = isSplit_(day);
      status = pending ? '' : attStatus_(t, split);
      if (t) {
        if (split) {
          var attended = 0, lateDays = 0, parts = [];
          [1, 2].forEach(function (n) {
            var d = t['day' + n];
            if (d && d.status === 'Attended') {
              attended++;
              if (d.punctuality === 'Late') { lateDays++; parts.push('Day' + n + ': ' + (d.time || '')); }
            }
          });
          if (attended) adherence = lateDays ? 'Late' : 'On Time';
          arrival = parts.join(' / ');
        } else if (t.status === 'Attended') {
          adherence = t.punctuality || 'On Time';
          arrival = adherence === 'Late' ? (t.time || '') : '';
        }
      }
    }
  }
  cols[HC.DATE] = date;
  cols[HC.SESSION] = session;
  cols[HC.STATUS] = status;
  cols[HC.ADHERENCE] = adherence;   // "On Time" / "Late", set when the trainer marks the pharmacist Attended
  cols[HC.ARRIVAL] = arrival;
  // The Notes column belongs to the people editing the sheet / the trainer's Notes box — it is never overwritten here.
  return cols;
}

/* ═════════════════════════ Table-backed collections (days / approvals / notifications) ═════════════════════════ */

function approvalsTable_(type, toRow, fromExtra) {
  return {
    tab: CONFIG.TABS.APPROVALS,
    ncols: 9,
    match: function (v) { return v[1] === type; },
    toRow: toRow,
    fromRow: function (v) {
      var obj = parseJson_(v[8]) || { id: v[0] };
      obj.id = v[0];
      if (v[2]) obj.status = v[2];                 // Status column is authoritative
      obj.rejectionReason = v[7] || obj.rejectionReason || '';
      return obj;
    }
  };
}

var TABLES = {
  days: {
    tab: CONFIG.TABS.DAYS,
    ncols: 15,
    toRow: function (d) {
      return [d.id, d.date || '', d.city || '', d.trainingName || '', d.type || '', (d.trainerNames || []).join(', '),
        d.isOnline ? 'Yes' : 'No', d.isOnline ? (d.onlineFormat || '') : '', d.coordinator || '', d.capacity || '',
        d.deadline || '', d.active === false ? 'No' : 'Yes', d.venue || '', (d.visibleSupervisors || []).join(', '), JSON.stringify(d)];
    },
    fromRow: function (v) { var d = parseJson_(v[14]); if (d) d.id = v[0]; return d; }
  },
  'pending-pharmacists': approvalsTable_('New Pharmacist', function (p) {
    return [p.id, 'New Pharmacist', p.status || 'Pending', p.supervisor || '', p.displayName || '', p.addedAt || '', p.decidedAt || '', p.rejectionReason || '', JSON.stringify(p)];
  }),
  'leave-requests': approvalsTable_('Annual Leave', function (r) {
    return [r.id, 'Annual Leave', r.status || 'Pending', r.supervisor || '', r.displayName || '', r.requestedAt || '', r.decidedAt || '', r.rejectionReason || '', JSON.stringify(r)];
  }),
  'quota-approval-history': approvalsTable_('Over-Quota Decision', function (h) {
    return [h.id, 'Over-Quota Decision', h.status || '', h.supervisor || '', h.displayName || '', '', h.decidedAt || '', h.rejectionReason || '', JSON.stringify(h)];
  }),
  'pharmacist-notifications': {
    tab: CONFIG.TABS.NOTIFS,
    ncols: 8,
    toRow: function (n) {
      return [n.id, n.supervisor || '', n.pharmacistName || '', n.result || '', n.reason || '', n.decidedAt || '', n.read ? 'Yes' : 'No', n.seenInHistory ? 'Yes' : 'No'];
    },
    fromRow: function (v) {
      return { id: v[0], supervisor: v[1], pharmacistName: v[2], result: v[3], reason: v[4], decidedAt: v[5], read: v[6] === 'Yes', seenInHistory: v[7] === 'Yes' };
    }
  }
};
// the Approvals tab also holds live mirrors of over-quota requests that are waiting for the trainer
var OQ_MIRROR_TYPE = 'Over-Quota Request';

function tRead_(t) {
  var sh = sheet_(t.tab);
  var last = sh.getLastRow();
  var rows = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, t.ncols).getDisplayValues();
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (!v[0]) continue;
      if (t.match && !t.match(v)) continue;
      rows.push({ row: i + 2, v: v });
    }
  }
  return { sh: sh, rows: rows };
}

function tList_(t) {
  return tRead_(t).rows.map(function (r) { return { id: r.v[0], v: t.fromRow(r.v) }; }).filter(function (x) { return x.v; });
}

/** records: { id: value | null }. Returns nothing; applies inserts/updates/deletes. */
function tPatch_(t, records) {
  var rd = tRead_(t);
  var byId = {};
  rd.rows.forEach(function (r) { byId[r.v[0]] = r; });
  var appends = [], deletes = [];
  Object.keys(records).forEach(function (id) {
    var val = records[id];
    if (val === null) { if (byId[id]) deletes.push(byId[id].row); return; }
    var arr = t.toRow(val).map(function (x) { return x == null ? '' : String(x); });
    arr[0] = id;
    if (byId[id]) rd.sh.getRange(byId[id].row, 1, 1, t.ncols).setNumberFormat('@').setValues([arr]);
    else appends.push(arr);
  });
  deleteRows_(rd.sh, deletes);
  appendRows_(rd.sh, t.ncols, appends);
}

function daysMap_() {
  var map = {};
  tList_(TABLES.days).forEach(function (x) { map[x.id] = x.v; });
  return map;
}

/* ═════════════════════════ Settings ═════════════════════════ */

function settings_() {
  var sh = sheet_(CONFIG.TABS.SETTINGS);
  var last = sh.getLastRow();
  var out = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 2).getDisplayValues().forEach(function (r) {
      if (r[0]) out[r[0]] = parseJson_(r[1]);
    });
  }
  return out;
}

function patchSettings_(patch) {
  var sh = sheet_(CONFIG.TABS.SETTINGS);
  var last = sh.getLastRow();
  var rowOf = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getDisplayValues().forEach(function (r, i) { if (r[0]) rowOf[r[0]] = i + 2; });
  Object.keys(patch).forEach(function (k) {
    var text = JSON.stringify(patch[k] === undefined ? null : patch[k]);
    if (text.length > 49000) throw new Error('Value for "' + k + '" is too large to store (limit ~49,000 characters).');
    if (rowOf[k]) sh.getRange(rowOf[k], 2).setNumberFormat('@').setValue(text);
    else {
      var r = sh.getLastRow() + 1;
      sh.getRange(r, 1, 1, 2).setNumberFormat('@').setValues([[k, text]]);
      rowOf[k] = r;
    }
  });
}

/* ═════════════════════════ READ ═════════════════════════ */

function getKey_(ctx, key) {
  switch (key) {
    case 'master-pharmacists': return getMaster_(ctx);
    case 'operations':         return getOps_(ctx);
    case 'training-config':    autoSyncCalendar_(); return getConfig_(ctx);
    case 'company-logo':       return { records: [], settings: { logo: settings_().logo || null } };
    case 'pending-pharmacists':
    case 'leave-requests':
    case 'quota-approval-history':
    case 'pharmacist-notifications': return getTable_(ctx, key);
  }
  throw new Error('Unknown data key.');
}

function masterOf_(v) {
  var m = {
    id: v[HC.ID - 1], district: v[HC.DISTRICT - 1], areaManager: v[HC.AREA - 1], city: v[HC.CITY - 1],
    supervisor: v[HC.SUPERVISOR - 1], pharmacyNo: v[HC.PHARMACY - 1], employeeId: v[HC.EMPID - 1], email: v[HC.EMAIL - 1],
    displayName: v[HC.NAME - 1], phone: v[HC.PHONE - 1], scfhs: v[HC.SCFHS - 1],
    note: v[HC.NOTES - 1]
  };
  if (v[HC.COMPLETION - 1] !== '') m.completionPct = v[HC.COMPLETION - 1];
  return m;
}

function getMaster_(ctx) {
  var hc = readHC_();
  var recs = [];
  hc.rows.forEach(function (r) {
    var m = masterOf_(r.v);
    if (ctx.role === 'supervisor') {
      if (m.supervisor !== ctx.who) return;
      // supervisors do not need contact / licence details of existing pharmacists — but they do see the sheet's Notes
      m = { id: m.id, district: m.district, areaManager: m.areaManager, city: m.city, supervisor: m.supervisor, email: m.email, displayName: m.displayName, note: m.note, completionPct: m.completionPct };
      if (m.completionPct === undefined) delete m.completionPct;
    }
    recs.push({ id: m.id, v: m });
  });
  return { records: recs, settings: {} };
}

function getOps_(ctx) {
  var hc = readHC_();
  var recs = [];
  hc.rows.forEach(function (r) {
    var a = parseJson_(r.v[HC.ASSIGN - 1]);
    var t = parseJson_(r.v[HC.ATT - 1]);
    if (!a && !t) return;
    var id = r.v[HC.ID - 1];
    if (ctx.role === 'supervisor' && r.v[HC.SUPERVISOR - 1] !== ctx.who) {
      // other supervisors' people: only the seat count matters (for capacity), no names / attendance
      if (a && a.type === 'date') recs.push({ id: id, v: { a: { type: 'date', dateId: a.dateId } } });
      return;
    }
    recs.push({ id: id, v: { a: a, t: t } });
  });
  return { records: recs, settings: {} };
}

function getConfig_(ctx) {
  var days = tList_(TABLES.days);
  var st = settings_();
  var settings = {};
  ['maxCapacity', 'trainerNames', 'coordinatorNames', 'trainingNames', 'completionCourse', 'completionLastSynced'].forEach(function (k) {
    if (st.hasOwnProperty(k) && st[k] !== null) settings[k] = st[k];
  });
  if (ctx.role === 'supervisor') {
    settings = { maxCapacity: settings.maxCapacity };
    days = days.map(function (x) {
      var d = x.v;
      var q = {};
      if (d.supervisorQuotas && d.supervisorQuotas.hasOwnProperty(ctx.who)) q[ctx.who] = d.supervisorQuotas[ctx.who];
      var copy = {};
      Object.keys(d).forEach(function (k) { copy[k] = d[k]; });
      copy.supervisorQuotas = q;
      delete copy.zoomLink;
      return { id: x.id, v: copy };
    });
  }
  return { records: days, settings: settings };
}

function getTable_(ctx, key) {
  var list = tList_(TABLES[key]);
  if (ctx.role === 'supervisor') list = list.filter(function (x) { return x.v.supervisor === ctx.who; });
  return { records: list, settings: {} };
}

function calendarGrid_() {
  return sheet_(CONFIG.TABS.CALENDAR).getDataRange().getDisplayValues();
}

/* ═════════════════════════ Calendar tab → TrainingDays (automatic sync) ═════════════════════════
 * The "2026 - Q4 Training Calendar" tab is the plan. Whenever the app loads its training days the
 * server checks (at most once a minute) whether that tab changed and, if so, brings TrainingDays
 * up to date:
 *   - a new entry in the grid becomes a training day (supervisors matched from HeadCount),
 *   - an entry that moved keeps its day (so assignments follow it) and gets the new date,
 *   - an entry removed from the grid is hidden from supervisors (never deleted automatically),
 *   - everything the trainer set in the app (visible-to, quotas, capacity, deadline, venue …) is kept.
 * Days the trainer added by hand have no calendar code and are never touched.
 */
var CAL_CODE_PATTERNS = [
  { re: /^JED\s*N/i, city: 'Jeddah North' }, { re: /^JED\s*S/i, city: 'Jeddah South' }, { re: /^JED/i, city: 'Jeddah' },
  { re: /^RUH/i, city: 'Riyadh' }, { re: /^MEC/i, city: 'Mecca' }, { re: /^MAD/i, city: 'Madinah' },
  { re: /^EAST/i, city: 'Eastern' }, { re: /^TAIF/i, city: 'Taif' }, { re: /^ABH/i, city: 'Abha' },
  { re: /^BAHAH/i, city: 'Al Bahah' }, { re: /^JAZ/i, city: 'Jazan' }
];
// same grouping the front end uses (cityCodeFor) so "Jeddah North" days match "Jeddah N" pharmacists
var CITY_CODE_PATTERNS = [
  { match: /jeddah\s*n|jed\s*n/i, code: 'JED N' }, { match: /jeddah\s*s|jed\s*s/i, code: 'JED S' }, { match: /jeddah|jed/i, code: 'JED' },
  { match: /riyadh|ruh/i, code: 'RUH' }, { match: /mecca|makkah|mec/i, code: 'MEC' }, { match: /madinah|medina|mad/i, code: 'MAD' },
  { match: /eastern|dammam|khobar|east/i, code: 'EAST' }, { match: /taif/i, code: 'TAIF' }, { match: /khamis|abha|abh/i, code: 'ABH' },
  { match: /bahah/i, code: 'BAH' }, { match: /jazan|jaz/i, code: 'JAZ' }
];
function cityCode_(city) {
  city = String(city || '');
  for (var i = 0; i < CITY_CODE_PATTERNS.length; i++) if (CITY_CODE_PATTERNS[i].match.test(city)) return CITY_CODE_PATTERNS[i].code;
  return city.slice(0, 4).toUpperCase();
}

/** Turns the calendar grid into [{code, date, city, isOnline, trainingName, trainer}] + names of entries that are not trainings. */
function parseCalendar_(grid) {
  var aoa = grid.filter(function (row) { return row.some(function (c) { return String(c == null ? '' : c).trim() !== ''; }); });
  var sheetYear = new Date().getFullYear();
  outer: for (var i = 0; i < Math.min(3, aoa.length); i++) {
    for (var j = 0; j < aoa[i].length; j++) {
      var ym = String(aoa[i][j] || '').match(/(20\d{2})/);
      if (ym) { sheetYear = parseInt(ym[1], 10); break outer; }
    }
  }
  var dateHeaderRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*(\d{1,2})\s+([A-Za-z]+)/i;   // "Mon 21 Sep" (space optional: "Mon14 Dec")
  var monthAbbrs = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var MAX_DAY_COLS = 5;   // widest day block; anything to the right is the summary tables, not trainings
  var lastMonthSeen = -1, yearForMonth = sheetYear;
  var found = [], skipped = {};

  function two(n) { return (n < 10 ? '0' : '') + n; }

  for (var r = 0; r < aoa.length; r++) {
    var row = aoa[r], anchors = [];
    for (var c = 0; c < row.length; c++) {
      var m = String(row[c] || '').trim().match(dateHeaderRe);
      if (!m) continue;
      var monIdx = monthAbbrs[m[3].slice(0, 3).toLowerCase()];
      if (monIdx === undefined) continue;
      if (lastMonthSeen !== -1 && monIdx < lastMonthSeen - 6) yearForMonth++;
      lastMonthSeen = monIdx;
      anchors.push({ col: c, date: yearForMonth + '-' + two(monIdx + 1) + '-' + two(parseInt(m[2], 10)) });
    }
    if (!anchors.length) continue;
    var codeRow = aoa[r + 1] || [], trainerRow = aoa[r + 2] || [];
    anchors.forEach(function (anchor, ai) {
      var nextCol = ai + 1 < anchors.length ? Math.min(anchors[ai + 1].col, anchor.col + MAX_DAY_COLS) : anchor.col + MAX_DAY_COLS;
      for (var col = anchor.col; col < nextCol; col++) {
        var code = String(codeRow[col] || '').trim();
        if (!code) continue;
        var trainerRaw = String(trainerRow[col] || '').trim();
        var looksLikeCode = /\d/.test(trainerRaw) || /^mix/i.test(trainerRaw) || CAL_CODE_PATTERNS.some(function (p) { return p.re.test(trainerRaw); });
        var low = trainerRaw.toLowerCase();
        var trainer = (trainerRaw && !looksLikeCode && low !== 'eg' && low !== 'co') ? trainerRaw : '';
        var norm = code.toUpperCase().replace(/\s+/g, '');
        if (/^mix/i.test(code)) {
          var nm = code.match(/\d+/);
          found.push({ code: norm, date: anchor.date, city: 'Online', isOnline: true, trainingName: nm ? 'Mix ' + nm[0] : 'Mix', trainer: trainer });
          continue;
        }
        var cm = null;
        for (var k = 0; k < CAL_CODE_PATTERNS.length; k++) if (CAL_CODE_PATTERNS[k].re.test(code)) { cm = CAL_CODE_PATTERNS[k]; break; }
        if (!cm) { if (!dateHeaderRe.test(code)) skipped[code] = true; continue; }
        found.push({ code: norm, date: anchor.date, city: cm.city, isOnline: false, trainingName: '', trainer: trainer });
      }
    });
  }

  // an online "Mix n" runs over two days and the grid lists it under BOTH dates → keep day 1 only
  function ms(iso) { var p = parseIso_(iso); return Date.UTC(p.y, p.m, p.d); }
  var lastMix = {}, entries = [];
  found.forEach(function (e) {
    if (e.isOnline) {
      var prev = lastMix[e.code];
      var gap = prev === undefined ? null : (ms(e.date) - prev) / 86400000;
      if (gap !== null && gap > 0 && gap <= 3) return;
      lastMix[e.code] = ms(e.date);
    }
    entries.push(e);
  });
  // identity of each entry = its code; if a code is (unexpectedly) used twice, number the repeats
  var counts = {};
  entries.forEach(function (e) {
    counts[e.code] = (counts[e.code] || 0) + 1;
    if (counts[e.code] > 1) e.code = e.code + '#' + counts[e.code];
  });
  return { entries: entries, skippedNames: Object.keys(skipped) };
}

function hashString_(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0) + ':' + s.length;
}

function calendarSupervisorsFor_(entry, hcRows) {
  var seen = {}, out = [];
  var want = entry.isOnline ? null : cityCode_(entry.city);
  hcRows.forEach(function (r) {
    var city = String(r.v[HC.CITY - 1]).trim();
    var sup = String(r.v[HC.SUPERVISOR - 1]).trim();
    if (!sup || sup === '-' || sup === '—' || seen[sup]) return;
    var ok = entry.isOnline ? city.toLowerCase() === 'online' : (city.toLowerCase() !== 'online' && cityCode_(city) === want);
    if (ok) { seen[sup] = true; out.push(sup); }
  });
  return out;
}

/** Brings TrainingDays in line with the calendar tab. Returns a summary. `force` skips the "did it change?" check. */
function syncCalendar_(force) {
  var grid = calendarGrid_();
  var hash = hashString_(JSON.stringify(grid));
  if (!force && settings_().calendarHash === hash) return { changed: false };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var st = settings_();
    if (!force && st.calendarHash === hash) return { changed: false };

    var parsed = parseCalendar_(grid);
    var hc = readHC_();
    var existing = tList_(TABLES.days).map(function (x) { return x.v; });
    var byCode = {};
    existing.forEach(function (d) { if (d.calendarCode) byCode[d.calendarCode] = d; });

    var roster = (st.trainerNames || []).slice();
    var newTrainers = [];
    function rosterName(name) {
      if (!name) return '';
      for (var i = 0; i < roster.length; i++) if (String(roster[i]).toLowerCase() === name.toLowerCase()) return roster[i];
      roster.push(name); newTrainers.push(name);
      return name;
    }

    var seen = {}, records = {}, changedIds = [];
    var summary = { added: 0, updated: 0, deactivated: 0, reactivated: 0, unmatched: [], skipped: parsed.skippedNames, trainersAdded: newTrainers };
    var unmatched = {};

    parsed.entries.forEach(function (e) {
      seen[e.code] = true;
      var trainer = rosterName(e.trainer);
      var d = byCode[e.code];
      if (!d) {
        d = {
          id: newId_('day', null), date: e.date, city: e.city, trainingName: e.trainingName, type: 'Pharmacist Training',
          trainerNames: trainer ? [trainer] : [], isOnline: e.isOnline, onlineFormat: e.isOnline ? 'split' : '',
          coordinator: '', zoomLink: '', visibleSupervisors: calendarSupervisorsFor_(e, hc.rows), active: true,
          calendarCode: e.code, calendarTrainer: trainer
        };
        records[d.id] = d; changedIds.push(d.id); summary.added++;
        if (!d.visibleSupervisors.length) unmatched[e.city] = true;
        return;
      }
      var before = JSON.stringify(d);
      d.date = e.date; d.city = e.city;
      // the trainer named in the calendar is applied unless someone changed the trainer in the app
      var cur = d.trainerNames || [], oldCal = d.calendarTrainer || '';
      if (cur.length === 0 || (cur.length === 1 && cur[0] === oldCal)) d.trainerNames = trainer ? [trainer] : [];
      d.calendarTrainer = trainer;
      if (d.removedFromCalendar) { d.removedFromCalendar = false; d.active = true; summary.reactivated++; }
      if (!d.visibleSupervisors || !d.visibleSupervisors.length) {
        d.visibleSupervisors = calendarSupervisorsFor_(e, hc.rows);
        if (!d.visibleSupervisors.length) unmatched[e.city] = true;
      }
      if (JSON.stringify(d) !== before) { records[d.id] = d; changedIds.push(d.id); summary.updated++; }
    });

    existing.forEach(function (d) {
      if (d.calendarCode && !seen[d.calendarCode] && !d.removedFromCalendar) {
        d.removedFromCalendar = true; d.active = false;
        records[d.id] = d; summary.deactivated++;
      }
    });
    summary.unmatched = Object.keys(unmatched);

    if (Object.keys(records).length) tPatch_(TABLES.days, records);
    var patch = { calendarHash: hash, calendarSyncedAt: nowIso_() };
    if (newTrainers.length) patch.trainerNames = roster;
    patchSettings_(patch);
    if (changedIds.length) refreshSessions_(changedIds);
    summary.changed = true;
    return summary;
  } finally {
    lock.releaseLock();
  }
}

/** Called whenever the app loads its training days; looks at the calendar tab at most once every 45 s. */
function autoSyncCalendar_() {
  var cache = CacheService.getScriptCache();
  if (cache.get('cal_check')) return;
  cache.put('cal_check', '1', 45);
  try { syncCalendar_(false); }
  catch (err) { Logger.log('Calendar auto-sync skipped: ' + err.message); }   // never let this break loading the app
}

function venues_() {
  var vals = sheet_(CONFIG.TABS.VENUES).getDataRange().getDisplayValues();
  var out = [], cCity = -1, cVenue = -1, start = -1;
  for (var r = 0; r < vals.length && start < 0; r++) {
    for (var c = 0; c < vals[r].length; c++) {
      var h = String(vals[r][c]).trim().toLowerCase();
      if (h === 'city') cCity = c;
      if (h.indexOf('venue') !== -1) cVenue = c;
    }
    if (cCity >= 0 && cVenue >= 0) start = r + 1; else { cCity = -1; cVenue = -1; }
  }
  if (start < 0) return out;
  for (var i = start; i < vals.length; i++) {
    var city = String(vals[i][cCity]).trim(), venue = String(vals[i][cVenue]).trim();
    if (city && venue) out.push({ city: city, venue: venue });
  }
  return out;
}

/* ═════════════════════════ WRITE ═════════════════════════ */

function patchKey_(ctx, req) {
  var key = req.key;
  var records = req.records || {};
  var settings = req.settings || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    switch (key) {
      case 'operations':               patchOps_(ctx, records); break;
      case 'master-pharmacists':       requireTrainer_(ctx); patchMaster_(records); break;
      case 'training-config':          requireTrainer_(ctx); patchConfig_(records, settings); break;
      case 'company-logo':             requireTrainer_(ctx); patchSettings_({ logo: settings.logo === undefined ? null : settings.logo }); break;
      case 'pending-pharmacists':
      case 'leave-requests':
      case 'pharmacist-notifications': patchTableGuarded_(ctx, key, records); break;
      case 'quota-approval-history':   requireTrainer_(ctx); tPatch_(TABLES[key], records); break;
      default: throw new Error('Unknown data key.');
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/* ---------- master roster (trainer only) ---------- */

function newHCRow_(id, m) {
  var row = [];
  for (var i = 0; i < HC.NCOLS; i++) row.push('');
  row[HC.ID - 1] = id;
  fillMasterCols_(row, m);
  return row;
}
function fillMasterCols_(row, m) {
  row[HC.DISTRICT - 1] = m.district || '';
  row[HC.AREA - 1] = m.areaManager || '';
  row[HC.CITY - 1] = m.city || '';
  row[HC.SUPERVISOR - 1] = m.supervisor || '';
  row[HC.PHARMACY - 1] = m.pharmacyNo || '';
  row[HC.EMPID - 1] = m.employeeId || '';
  row[HC.EMAIL - 1] = m.email || '';
  row[HC.NAME - 1] = m.displayName || '';
  row[HC.PHONE - 1] = m.phone || '';
  row[HC.SCFHS - 1] = m.scfhs || '';
  row[HC.COMPLETION - 1] = (m.completionPct === undefined || m.completionPct === null) ? '' : String(m.completionPct);
  // only touch Notes when the caller sent one, so approvals / roster edits never wipe a note typed in the sheet
  if (m.note !== undefined) row[HC.NOTES - 1] = m.note === null ? '' : String(m.note);
}

function patchMaster_(records) {
  var hc = readHC_();
  var byId = {};
  hc.rows.forEach(function (r) { byId[r.v[HC.ID - 1]] = r; });
  var updates = [], deletes = [], appends = [];
  Object.keys(records).forEach(function (id) {
    var m = records[id];
    var ex = byId[id];
    if (m === null) { if (ex) deletes.push(ex.row); return; }
    if (ex) {
      var tmp = ex.v.slice();
      fillMasterCols_(tmp, m);
      var cols = {};
      [HC.DISTRICT, HC.AREA, HC.CITY, HC.SUPERVISOR, HC.PHARMACY, HC.EMPID, HC.EMAIL, HC.NAME, HC.PHONE, HC.SCFHS, HC.COMPLETION, HC.NOTES].forEach(function (c) {
        if (tmp[c - 1] !== ex.v[c - 1]) cols[c] = tmp[c - 1];
      });
      if (Object.keys(cols).length) updates.push({ row: ex.row, cols: cols });
    } else {
      appends.push(newHCRow_(id, m));
    }
  });
  writeCells_(hc.sh, updates);
  deleteRows_(hc.sh, deletes);
  appendRows_(hc.sh, HC.NCOLS, appends);
  CacheService.getScriptCache().remove('sup_names');   // roster changed → refresh the supervisor list
}

/* ---------- assignments & attendance ---------- */

function patchOps_(ctx, records) {
  var ids = Object.keys(records);
  if (!ids.length) return;
  var hc = readHC_();
  var days = daysMap_();
  var st = settings_();
  var defaultCap = Number(st.maxCapacity) || CONFIG.DEFAULT_CAPACITY;
  var byId = {};
  hc.rows.forEach(function (r) { byId[r.v[HC.ID - 1]] = r; });

  // seat counts from the CURRENT sheet state (this is what makes capacity safe under concurrency)
  var counts = {};
  var supCounts = {};   // dateId -> supervisor -> count
  hc.rows.forEach(function (r) {
    var a = parseJson_(r.v[HC.ASSIGN - 1]);
    if (a && a.type === 'date') {
      counts[a.dateId] = (counts[a.dateId] || 0) + 1;
      var sup = r.v[HC.SUPERVISOR - 1];
      supCounts[a.dateId] = supCounts[a.dateId] || {};
      supCounts[a.dateId][sup] = (supCounts[a.dateId][sup] || 0) + 1;
    }
  });
  function bump(a, sup, delta) {
    if (a && a.type === 'date') {
      counts[a.dateId] = (counts[a.dateId] || 0) + delta;
      supCounts[a.dateId] = supCounts[a.dateId] || {};
      supCounts[a.dateId][sup] = (supCounts[a.dateId][sup] || 0) + delta;
    }
  }

  var updates = [], mirrorUp = {};
  ids.forEach(function (id) {
    var row = byId[id];
    if (!row) return;
    var rec = records[id] || {};
    var curA = parseJson_(row.v[HC.ASSIGN - 1]);
    var curT = parseJson_(row.v[HC.ATT - 1]);
    var a = rec.hasOwnProperty('a') ? rec.a : curA;
    var t = rec.hasOwnProperty('t') ? rec.t : curT;
    var sup = row.v[HC.SUPERVISOR - 1];

    if (ctx.role === 'supervisor') {
      if (sup !== ctx.who) throw new Error('Not allowed: that pharmacist belongs to another supervisor.');
      if (rec.hasOwnProperty('t') && rec.t !== null) throw new Error('Only trainers can record attendance.');
      if (rec.hasOwnProperty('a')) {
        bump(curA, sup, -1);                                   // free the old seat first
        try {
          a = validateSupervisorAssignment_(ctx, row, curA, rec.a, days, counts, supCounts, defaultCap);
        } catch (e) { bump(curA, sup, +1); throw e; }
        bump(a, sup, +1);
      }
    } else if (rec.hasOwnProperty('a')) {
      bump(curA, sup, -1);
      bump(a, sup, +1);
    }

    var cols = derivedCols_(a, t, days);
    updates.push({ row: row.row, cols: cols });

    var pending = a && a.type === 'date' && a.overQuota && !a.quotaApproved;
    mirrorUp['oq_' + id] = pending ? { pid: id, sup: sup, name: row.v[HC.NAME - 1], a: a } : null;
  });

  writeCells_(hc.sh, updates);
  syncOverQuotaMirrors_(mirrorUp, days);
}

function validateSupervisorAssignment_(ctx, row, oldA, newA, days, counts, supCounts, defaultCap) {
  if (newA === null) return null;
  if (!newA || typeof newA !== 'object') throw new Error('Invalid assignment.');
  var pid = row.v[HC.ID - 1];
  if (newA.type === 'leave') {
    if (LEAVE_STATUSES.indexOf(newA.status) === -1) throw new Error('Invalid status.');
    return { type: 'leave', status: newA.status, assignedBy: ctx.who, assignedAt: nowIso_() };
  }
  if (newA.type !== 'date') throw new Error('Invalid assignment type.');
  var day = days[newA.dateId];
  if (!day) throw new Error('That training day no longer exists.');
  var sameDay = oldA && oldA.type === 'date' && oldA.dateId === newA.dateId;
  if (!sameDay) {
    if (day.active === false) throw new Error('That training day is not open.');
    if ((day.visibleSupervisors || []).indexOf(ctx.who) === -1) throw new Error('That training day is not available to you.');
    var pharmacistOnline = String(row.v[HC.CITY - 1]).trim().toLowerCase() === 'online';
    if (pharmacistOnline !== !!day.isOnline) throw new Error('Online pharmacists can only join online days (and vice versa).');
    if (day.deadline) {
      var dl = Date.parse(day.deadline);
      if (!isNaN(dl) && Date.now() > dl) throw new Error('The deadline for that training day has passed.');
    }
    var cap = day.capacity > 0 ? Number(day.capacity) : defaultCap;
    if ((counts[newA.dateId] || 0) >= cap) throw new Error('That training day is full (' + cap + ').');
  }
  var out = { type: 'date', dateId: newA.dateId, assignedBy: ctx.who, assignedAt: sameDay && oldA.assignedAt ? oldA.assignedAt : nowIso_(), overQuota: false, quotaApproved: true };
  if (day.isOnline && day.supervisorQuotas && day.supervisorQuotas.hasOwnProperty(ctx.who)) {
    if (sameDay && oldA.overQuota) {
      out.overQuota = true; out.quotaApproved = !!oldA.quotaApproved;   // keep the trainer's earlier decision
    } else {
      var quota = Number(day.supervisorQuotas[ctx.who]);
      var mine = (supCounts[newA.dateId] && supCounts[newA.dateId][ctx.who]) || 0;   // seat already freed above
      if (mine >= quota) { out.overQuota = true; out.quotaApproved = false; }
    }
  }
  return out;
}

/** Keeps a live "Over-Quota Request" row in the Approvals tab for every assignment still waiting on the trainer. */
function syncOverQuotaMirrors_(mirrorUp, days) {
  var keys = Object.keys(mirrorUp);
  if (!keys.length) return;
  var t = {
    tab: CONFIG.TABS.APPROVALS, ncols: 9,
    match: function (v) { return v[1] === OQ_MIRROR_TYPE; },
    toRow: function (m) {
      var day = days[m.a.dateId];
      return ['', OQ_MIRROR_TYPE, 'Pending', m.sup, m.name + (day ? ' — ' + day.city + ' ' + dayLabel_(day) : ''), m.a.assignedAt || '', '', '', JSON.stringify({ pid: m.pid, dateId: m.a.dateId })];
    }
  };
  var recs = {};
  keys.forEach(function (k) { recs[k] = mirrorUp[k]; });
  tPatch_(t, recs);
}

/* ---------- training config: days + settings (trainer only) ---------- */

function patchConfig_(records, settings) {
  var changed = Object.keys(records);
  if (changed.length) tPatch_(TABLES.days, records);
  var keys = Object.keys(settings);
  if (keys.length) patchSettings_(settings);
  if (changed.length) refreshSessions_(changed);
}

/** After a training day changes, refresh the date/session text of everyone assigned to it. */
function refreshSessions_(dayIds) {
  var set = {};
  dayIds.forEach(function (id) { set[id] = true; });
  var hc = readHC_();
  var days = daysMap_();
  var updates = [];
  hc.rows.forEach(function (r) {
    var a = parseJson_(r.v[HC.ASSIGN - 1]);
    if (a && a.type === 'date' && set[a.dateId]) {
      var cols = derivedCols_(a, parseJson_(r.v[HC.ATT - 1]), days);
      updates.push({ row: r.row, cols: cols });
    }
  });
  writeCells_(hc.sh, updates);
}

/* ---------- approvals / notifications with supervisor guard ---------- */

function patchTableGuarded_(ctx, key, records) {
  var t = TABLES[key];
  if (ctx.role === 'trainer') { tPatch_(t, records); return; }
  var existing = {};
  tList_(t).forEach(function (x) { existing[x.id] = x.v; });
  var safe = {};
  Object.keys(records).forEach(function (id) {
    var v = records[id], ex = existing[id];
    if (key === 'pharmacist-notifications') {
      if (v === null) throw new Error('Not allowed.');
      if (!ex || ex.supervisor !== ctx.who) throw new Error('Not allowed.');
      // only the read / seen flags may change
      safe[id] = { id: id, supervisor: ex.supervisor, pharmacistName: ex.pharmacistName, result: ex.result, reason: ex.reason, decidedAt: ex.decidedAt, read: !!v.read, seenInHistory: !!v.seenInHistory };
      return;
    }
    // pending-pharmacists / leave-requests
    if (v === null) {
      if (!ex || ex.supervisor !== ctx.who || ex.status !== 'Pending') throw new Error('Only your own pending requests can be removed.');
      safe[id] = null;
      return;
    }
    if (v.supervisor !== ctx.who) throw new Error('Requests can only be submitted for your own name.');
    if (ex && (ex.supervisor !== ctx.who || ex.status !== 'Pending')) throw new Error('This request has already been decided.');
    if (v.status !== 'Pending') throw new Error('New requests must start as Pending.');
    safe[id] = v;
  });
  tPatch_(t, safe);
}

/* ═════════════════════════ ONE-TIME SETUP (run from the Apps Script editor) ═════════════════════════ */

function setupSheets() {
  var ss = ss_();
  var hcSheet = sheet_(CONFIG.TABS.HEADCOUNT);

  // 1) HeadCount: columns are found by header text. Any the app needs but the sheet lacks are added on the right;
  //    your own columns (including ones you inserted) are left exactly where they are.
  HC_LAYOUT_DONE = false;
  initHCLayout_(hcSheet);
  var headerFormat = hcSheet.getRange(1, HC.STATUS);
  HC_FIELDS.forEach(function (f) {
    if (f[2] && HC[f[0]]) headerFormat.copyTo(hcSheet.getRange(1, HC[f[0]]), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  });
  hcSheet.getRange(1, 1, hcSheet.getMaxRows(), HC.NCOLS).setNumberFormat('@');   // keep phones / IDs / times as typed
  hcSheet.hideColumns(HC.ASSIGN);                                                // system JSON columns
  hcSheet.hideColumns(HC.ATT);
  readHC_();                                                                     // gives every pharmacist an ID and repairs misplaced ones

  // 2) Extra tabs the app needs
  ensureTab_(ss, CONFIG.TABS.DAYS, ['ID', 'Date', 'City', 'Training Name', 'Type', 'Trainer(s)', 'Online', 'Format', 'Coordinator', 'Capacity', 'Deadline', 'Active', 'Venue', 'Visible To (supervisors)', 'Data (system)']);
  ensureTab_(ss, CONFIG.TABS.APPROVALS, ['ID', 'Type', 'Status', 'Supervisor', 'Pharmacist', 'Submitted At', 'Decided At', 'Reason', 'Data (system)']);
  ensureTab_(ss, CONFIG.TABS.NOTIFS, ['ID', 'Supervisor', 'Pharmacist / Subject', 'Result', 'Reason', 'Date', 'Read', 'Seen in History']);
  ensureTab_(ss, CONFIG.TABS.SETTINGS, ['Key', 'Value (JSON)']);
  ss.getSheetByName(CONFIG.TABS.DAYS).hideColumns(15);
  ss.getSheetByName(CONFIG.TABS.APPROVALS).hideColumns(9);

  // 3) Defaults
  var st = settings_();
  if (st.maxCapacity === undefined) patchSettings_({ maxCapacity: CONFIG.DEFAULT_CAPACITY });

  // 4) Re-derive the visible columns (Date, Attendance Status, Attendance Adherence, Session, Arrival Time) from what is saved
  recomputeAllRows_();

  Logger.log('Setup complete. Tabs: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
  Logger.log('Next: add TRAINER_USER and TRAINER_PASS under Project Settings > Script Properties, then deploy as a Web App.');
}

/** Rewrites the readable columns of every row that has an assignment or attendance, from the saved (system) data. */
function recomputeAllRows_() {
  var hc = readHC_();
  var days = daysMap_();
  var updates = [];
  hc.rows.forEach(function (r) {
    var a = parseJson_(r.v[HC.ASSIGN - 1]), t = parseJson_(r.v[HC.ATT - 1]);
    if (a || t) updates.push({ row: r.row, cols: derivedCols_(a, t, days) });
  });
  writeCells_(hc.sh, updates);
  Logger.log('Refreshed ' + updates.length + ' pharmacist row(s).');
}

function ensureTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0b2b5c').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

/** Optional: run from the editor to confirm the tabs and columns look right. */
function checkSetup() {
  var hc = readHC_();
  var missingTabs = [];
  Object.keys(CONFIG.TABS).forEach(function (k) { if (!ss_().getSheetByName(CONFIG.TABS[k])) missingTabs.push(CONFIG.TABS[k]); });
  var props = PropertiesService.getScriptProperties();
  function letter(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  Logger.log('HeadCount columns found: ' + HC_FIELDS.map(function (f) { return f[0] + '=' + letter(HC[f[0]]); }).join(', '));
  Logger.log('Pharmacist rows: ' + hc.rows.length);
  Logger.log('Supervisors: ' + supervisorNames_().length);
  Logger.log('Missing tabs: ' + (missingTabs.length ? missingTabs.join(', ') : 'none'));
  Logger.log('Trainer credentials set: ' + (!!props.getProperty('TRAINER_USER') && !!props.getProperty('TRAINER_PASS')));
}
