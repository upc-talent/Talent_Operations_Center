/* Shared helpers used by BOTH the Supervisor and Trainer pages.
   (Extracted from the original single-file tool — logic unchanged unless noted.) */
/* ═══════════════════════════════ STORAGE HELPERS ═══════════════════════════════ */
const K_MASTER  = 'master-pharmacists';
const K_CONFIG  = 'training-config';
const K_OPS     = 'operations';
const K_LOGO    = 'company-logo';
const K_PENDING = 'pending-pharmacists';
const K_NOTIF   = 'pharmacist-notifications';
const K_LEAVE_REQUESTS = 'leave-requests';
const K_QUOTA_HISTORY = 'quota-approval-history';
const K_CHANGE_REQ = 'change-requests';          // supervisor "Request Change" for a locked pharmacist
const K_SUBMISSIONS = 'supervisor-submissions';   // a supervisor pressed Submit (trainer only)
const K_MERGES = 'group-merges';               // parallel online groups run as one session (staff only)
const K_DATA_EDIT = 'data-edit-requests';       // supervisor asks to correct a pharmacist's details

function uid(p){ return p+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function nowIso(){ return new Date().toISOString(); }
function nowTimeStr(){ const d=new Date(); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function formatDate(isoDate){
  if(!isoDate) return '';
  const d = new Date(isoDate+'T00:00:00');
  if(isNaN(d)) return isoDate;
  const yy = String(d.getFullYear()).slice(-2);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${yy}`;
}
function dayDateLabel(day){
  if(!day || !day.date) return '';
  if(!(day.isOnline && day.onlineFormat==='split')) return formatDate(day.date);
  const d1 = new Date(day.date+'T00:00:00');
  if(isNaN(d1)) return formatDate(day.date);
  const d2 = new Date(d1);
  d2.setDate(d2.getDate()+1);
  const yy = String(d1.getFullYear()).slice(-2);
  if(d1.getMonth()===d2.getMonth()) return `${d1.getDate()} - ${d2.getDate()} ${MONTHS[d1.getMonth()]} ${yy}`;
  return `${d1.getDate()} ${MONTHS[d1.getMonth()]} - ${d2.getDate()} ${MONTHS[d2.getMonth()]} ${yy}`;
}
function addOneDayIso(isoDate){
  const parts = (isoDate||'').split('-').map(Number);
  if(parts.length!==3 || parts.some(isNaN)) return '';
  const dt = new Date(Date.UTC(parts[0], parts[1]-1, parts[2]+1));
  return dt.toISOString().slice(0,10);
}
function formatDateTime(dtLocal){
  if(!dtLocal) return '';
  const d = new Date(dtLocal);
  if(isNaN(d)) return dtLocal;
  const yy = String(d.getFullYear()).slice(-2);
  let h = d.getHours();
  const ampm = h>=12 ? 'PM' : 'AM';
  h = h % 12; if(h===0) h = 12;
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${yy}, ${h}:${mm} ${ampm}`;
}

function toast(msg, type){
  const box = document.createElement('div');
  box.className = 'toast-item ' + (type==='err'?'err':type==='info'?'info':'ok');
  box.textContent = msg;
  document.getElementById('toast').appendChild(box);
  setTimeout(()=>box.remove(), Math.max(3200, String(msg).length*60));   // long messages stay up long enough to read
}

const LEAVE_STATUSES = ['Sick Leave','Annual Leave','Resignation','Promotion'];

const TRAINER_PALETTE = [
  {bg:'#e5f0fb', text:'#0a4a86'}, {bg:'#e7f7ee', text:'#1f9d55'}, {bg:'#fff4e2', text:'#b8720a'},
  {bg:'#fdecea', text:'#c0392b'}, {bg:'#f4ebfb', text:'#7a3fb0'}, {bg:'#e0f7fa', text:'#00796b'},
  {bg:'#fce4ec', text:'#ad1457'}, {bg:'#fff9c4', text:'#8d6e00'}, {bg:'#ede7f6', text:'#4527a0'},
  {bg:'#e8f5e9', text:'#2e7d32'}
];
function trainerColor(name){
  if(!name) return {bg:'#eee', text:'#666'};
  let hash = 0;
  for(let i=0;i<name.length;i++){ hash = name.charCodeAt(i) + ((hash<<5)-hash); }
  return TRAINER_PALETTE[Math.abs(hash) % TRAINER_PALETTE.length];
}
function trainerBadge(name){
  if(!name) return '—';
  const c = trainerColor(name);
  return `<span class="badge" style="background:${c.bg};color:${c.text};border:1px solid ${c.text};">${esc(name)}</span>`;
}

// Hidden-from-supervisors state: 👁 = visible, this eye-with-a-slash = hidden (like a password field). Dropdowns can only show
// text, so there a hidden day ends with 🚫 instead.
const EYE_OFF_SVG = '<svg class="ico-eye-off" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

/* City short-code labels (for pill text) */
const CITY_CODE_PATTERNS = [
  {match:/jeddah\s*n|jed\s*n/i, code:'JED N'},
  {match:/jeddah\s*s|jed\s*s/i, code:'JED S'},
  {match:/jeddah|jed/i, code:'JED'},
  {match:/riyadh|ruh/i, code:'RUH'},
  {match:/mecca|makkah|mec/i, code:'MEC'},
  {match:/madinah|medina|mad/i, code:'MAD'},
  {match:/eastern|dammam|khobar|east/i, code:'EAST'},
  {match:/taif/i, code:'TAIF'},
  {match:/khamis|abha|abh/i, code:'ABH'},
  {match:/bahah/i, code:'BAH'},
  {match:/jazan|jaz/i, code:'JAZ'}
];
function cityCodeFor(city){
  city = city || '';
  const found = CITY_CODE_PATTERNS.find(c=>c.match.test(city));
  if(found) return found.code;
  return city.slice(0,4).toUpperCase() || '—';
}

/* Fixed region-group color scheme, per district groupings:
   JED N & JED S = blue, JAZ/BAH/ABH/TAIF = green, MAD/MEC = yellow, RUH = purple, Mix/Online = grey */
const COLOR_PALETTE = {
  blue:   {bg:'#BDD7EE', border:'#4472C4', text:'#1f3864'},
  green:  {bg:'#C6E0B4', border:'#548235', text:'#375522'},
  yellow: {bg:'#FFE699', border:'#BF9000', text:'#7f6000'},
  purple: {bg:'#D1B2E8', border:'#7030A0', text:'#4c1a70'},
  grey:   {bg:'#BFBFBF', border:'#595959', text:'#333'}
};
const CITY_GROUP_COLOR = {
  'JED N':'blue', 'JED S':'blue', 'JED':'blue',
  'JAZ':'green', 'BAH':'green', 'ABH':'green', 'TAIF':'green',
  'MAD':'yellow', 'MEC':'yellow',
  'RUH':'purple', 'EAST':'purple'
};
const FALLBACK_PALETTE = [
  {bg:'#F8CBAD', border:'#C55A11', text:'#7a370a'}, {bg:'#B4E4E0', border:'#0E7C86', text:'#0b4f56'},
  {bg:'#F4CCCC', border:'#CC0000', text:'#7a0000'}, {bg:'#D9EAD3', border:'#38761D', text:'#274e13'},
  {bg:'#FFD9B3', border:'#E36C09', text:'#8a4108'}, {bg:'#ede7f6', border:'#4527a0', text:'#4527a0'}
];
const ONLINE_COLOR = {code:'MIX', ...COLOR_PALETTE.grey};

function cityColorFor(day){
  if(day.isOnline) return ONLINE_COLOR;
  const code = cityCodeFor(day.city || '');
  const group = CITY_GROUP_COLOR[code];
  if(group) return {code, ...COLOR_PALETTE[group]};
  let hash=0; for(let i=0;i<code.length;i++){ hash = code.charCodeAt(i) + ((hash<<5)-hash); }
  const fb = FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
  return {code, bg:fb.bg, border:fb.border, text:fb.text};
}

/* ═══════════════════════════════ CUSTOM CONFIRM MODAL (native confirm() is blocked in the artifact sandbox) ═══════════════════════════════ */
function confirmDialog(message){
  return new Promise(resolve=>{
    showModal(`<h3>Please Confirm</h3><p style="font-size:13px;color:var(--text);line-height:1.6;">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-outline btn-sm" id="cd-cancel">Cancel</button>
        <button class="btn btn-danger btn-sm" id="cd-ok">Confirm</button>
      </div>`);
    document.getElementById('cd-ok').onclick = ()=>{ closeModal(); resolve(true); };
    document.getElementById('cd-cancel').onclick = ()=>{ closeModal(); resolve(false); };
  });
}
function promptForFilename(defaultBaseName, extension){
  return new Promise(resolve=>{
    showModal(`<h3>Save File</h3>
      <div class="field"><label class="field-label">File name</label>
        <div class="row" style="flex-wrap:nowrap;">
          <input type="text" id="fnPromptInput" value="${esc(defaultBaseName)}" style="flex:1;">
          <span class="small-note">.${esc(extension)}</span>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline btn-sm" id="fnPromptCancel">Cancel</button>
        <button class="btn btn-navy btn-sm" id="fnPromptOk">Download</button>
      </div>`);
    const input = document.getElementById('fnPromptInput');
    input.focus();
    input.select();
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') document.getElementById('fnPromptOk').click(); });
    document.getElementById('fnPromptOk').onclick = ()=>{
      let val = input.value.trim().replace(/[\\/:*?"<>|]/g, '-');
      if(!val) val = defaultBaseName;
      closeModal();
      resolve(val + '.' + extension);
    };
    document.getElementById('fnPromptCancel').onclick = ()=>{ closeModal(); resolve(null); };
  });
}
let masterData = [];
let pendingList = [];
let trainingConfig = {dates:[], maxCapacity:30, trainerNames:[], coordinatorNames:[]};
let ops = {assignments:{}, attendance:{}, shifts:{}, history:{}};
let leaveRequestsCache = [];
// Core / Capsule completion (v5): the two courses chosen in Reports Configuration → Hub columns, read-only.
// {core: {courseId, name, lastPublishedAt, byEmail:{email:{s,r,f,d}}} | null, capsule: … }. Supervisors get only r (%).
const K_COURSE_SLOTS = 'course-slots';
let courseSlots = {core:null, capsule:null};
async function loadCoreData(){
  // one request for all of them (a single round-trip)
  const r = await getSharedMany([K_MASTER, K_PENDING, K_CONFIG, K_OPS, K_COURSE_SLOTS], {
    [K_MASTER]: [],
    [K_PENDING]: [],
    [K_CONFIG]: {dates:[], maxCapacity:30, trainerNames:[], coordinatorNames:[], trainingNames:[]},
    [K_OPS]: {assignments:{}, attendance:{}, shifts:{}, history:{}},
    [K_COURSE_SLOTS]: {core:null, capsule:null}
  });
  masterData = r[K_MASTER]; pendingList = r[K_PENDING]; trainingConfig = r[K_CONFIG]; ops = r[K_OPS];
  courseSlots = r[K_COURSE_SLOTS] || {core:null, capsule:null};
  if(!trainingConfig.dates) trainingConfig.dates = [];
  if(!trainingConfig.trainerNames) trainingConfig.trainerNames = [];
  if(!trainingConfig.coordinatorNames) trainingConfig.coordinatorNames = [];
  if(!trainingConfig.trainingNames) trainingConfig.trainingNames = [];
  if(!trainingConfig.maxCapacity) trainingConfig.maxCapacity = 30;
  if(!Array.isArray(trainingConfig.cityRoster)) trainingConfig.cityRoster = [];
  if(!ops.shifts) ops.shifts = {};
  if(!ops.history) ops.history = {};
}

/* ═══════════════════════════════ OPTIMISTIC BACKGROUND SAVE ═══════════════════════════════
   The screen is updated immediately by the caller; this persists the change in the background so a click never
   waits on the ~½‑second network round‑trip. Rapid changes are COALESCED — while one save is in flight, further
   changes just mark the key dirty and are captured by a single follow‑up save (setShared always diffs the current
   value against the last saved snapshot, so one request carries everything pending). On failure, setShared() fires
   APP_HOOKS.onSaveFailed, which reloads the real state and re‑renders — reverting the optimistic change. The
   floating sync pill (Sending…/Saved) is driven by the requests themselves, so it still reflects what's happening. */
const _saveQueue = {};
function saveShared(key, getValue){
  const s = _saveQueue[key] || (_saveQueue[key] = { saving:false, dirty:false });
  if(s.saving){ s.dirty = true; return; }
  s.saving = true;
  (async ()=>{
    try{
      do{
        s.dirty = false;
        const ok = await setShared(key, getValue());
        if(!ok) break;   // onSaveFailed already reloaded the true state; stop coalescing
      } while(s.dirty);
    } finally { s.saving = false; }
  })();
}

async function loadLogo(){
  // The default logo is assets/img/logo.png (already in each page's HTML). A logo uploaded on
  // Trainer > Setup (card since removed) is stored in the database and, if present, replaces it; "Remove Logo" goes back to the file.
  const logo = await getShared(K_LOGO, null);
  const box = document.getElementById('logoBox');
  box.innerHTML = logo ? `<img src="${logo}" alt="Logo">` : '<img src="assets/img/logo.png" alt="Talent Operations Center logo">';
}

/* ═══════════════════════════════ SYNC STATUS INDICATOR (top bar: loading / sending / saved) ═══════════════════════════════
   Fed by assets/js/api.js, which tracks every request the page makes — so this covers the whole app
   (every click that reads or saves data) without each function having to report its own status. */
const SYNC_STATUS_LABELS = { loading:'Retrieving…', saving:'Sending…', saved:'Saved' };
function initSyncStatusIndicator(){
  const el = document.getElementById('syncStatus');
  if(!el || typeof onApiStatusChange !== 'function') return;
  const txt = el.querySelector('.txt');
  onApiStatusChange(status=>{
    el.classList.remove('loading','saving','saved');
    if(status==='idle'){ el.classList.remove('show'); return; }
    el.classList.add('show', status);
    if(txt) txt.textContent = SYNC_STATUS_LABELS[status] || '';
  });
}

/* ═══════════════════════════════ CAPACITY HELPERS ═══════════════════════════════ */
function dayCount(dateId, excludingPid){
  return Object.entries(ops.assignments||{}).filter(([pid,a])=>a.type==='date' && a.dateId===dateId && pid!==excludingPid).length;
}
function dayCapacity(day){
  return (day && day.capacity && day.capacity>0) ? day.capacity : trainingConfig.maxCapacity;
}
function capacityStatus(count, max){
  max = max || trainingConfig.maxCapacity;
  return count>=max ? {cls:'danger', tag:'Full'} : {cls:'available', tag:'Available'};
}
function isDayFull(dateId, excludingPid){
  const day = dayById(dateId);
  return dayCount(dateId, excludingPid) >= dayCapacity(day);
}
function visibleDaysFor(supervisorName){
  return trainingConfig.dates.filter(d=>d.active!==false && d.visibleSupervisors && d.visibleSupervisors.includes(supervisorName));
}

/* Fast id → training-day lookup. Replaces repeated trainingConfig.dates.find(...) linear scans in the
   render/sort hot paths (they ran O(rows × days) per redraw and O(comparisons × days) per sort).
   The index is rebuilt whenever the dates array is replaced (undo/redo, reload) or changes length
   (a day added/removed); in-place field edits keep the same day objects, so lookups stay current. */
let _dayIndex = null, _dayIndexSrc = null, _dayIndexLen = -1;
function dayById(id){
  const arr = (typeof trainingConfig !== 'undefined' && trainingConfig.dates) || [];
  if(_dayIndexSrc !== arr || _dayIndexLen !== arr.length){
    _dayIndex = new Map();
    for(const d of arr) _dayIndex.set(d.id, d);
    _dayIndexSrc = arr; _dayIndexLen = arr.length;
  }
  return _dayIndex.get(id) || null;
}

/* ═══════════════════════════════ MULTI-SELECT FILTER WIDGET ═══════════════════════════════ */
let supFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), date:new Set(), retrain:new Set() };
let supSearchQ = '';
let trainerFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), date:new Set(), retrain:new Set() };
let trainerSearchQ = '';
let masterFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), date:new Set() };
let masterSearchQ = '';
let daysFilterState = { city:new Set(), type:new Set(), date:new Set(), trainer:new Set(), visibleTo:new Set(), status:new Set() };
let daysSearchQ = '';
let msOptionsCache = {};

// Other tables (Moodle Reports, the public reports page) register their own filter state + re-render here.
const EXTRA_FILTER_SCOPES = {};
function registerFilterScope(scope, getState, rerender){ EXTRA_FILTER_SCOPES[scope] = {getState, rerender}; }
function filterStateFor(scope){
  if(EXTRA_FILTER_SCOPES[scope]) return EXTRA_FILTER_SCOPES[scope].getState();
  if(scope==='sup') return supFilterState;
  if(scope==='trainer') return trainerFilterState;
  if(scope==='days') return daysFilterState;
  return masterFilterState;
}
function rerenderScope(scope){
  if(EXTRA_FILTER_SCOPES[scope]) EXTRA_FILTER_SCOPES[scope].rerender();
  else if(scope==='sup') renderSupervisorTable();
  else if(scope==='trainer') renderTrainerTable();
  else if(scope==='days') renderDaysTable();
  else renderMasterSheetPreview();
}

/* ═══════════════════════════════ BULK SELECTION (checkboxes + action bar) ═══════════════════════════════
   Shared by the trainer records table, the days table and the supervisor table. Each row carries a checkbox;
   when anything is selected a bar (#bulkBar-<scope>) shows the count and the actions. The per-scope ACTION
   functions (bulkApplyTrainerAssign / bulkApplySupAssign / bulkDeletePharmacists / bulkDays) live in the page
   that owns that table. Selection is kept in a Set and pruned to the currently-visible rows on every full render,
   so "what's selected" always matches what's on screen. */
const bulkSel = { trainer:new Set(), sup:new Set(), days:new Set() };
const bulkVisible = { trainer:[], sup:[], days:[] };

function bulkCheckboxCell(scope, id){
  const checked = bulkSel[scope].has(id) ? 'checked' : '';
  return `<td class="sel-cell"><input type="checkbox" class="rowsel rowsel-${scope}" ${checked} onclick="event.stopPropagation(); bulkToggle('${scope}','${id}',this.checked)"></td>`;
}
function bulkToggle(scope, id, checked){
  if(checked) bulkSel[scope].add(id); else bulkSel[scope].delete(id);
  updateBulkBar(scope);
}
function bulkToggleAll(scope, checked){
  bulkVisible[scope].forEach(id=>{ if(checked) bulkSel[scope].add(id); else bulkSel[scope].delete(id); });
  document.querySelectorAll('.rowsel-'+scope).forEach(cb=>{ cb.checked = checked; });
  updateBulkBar(scope);
}
function bulkClear(scope){
  bulkSel[scope].clear();
  document.querySelectorAll('.rowsel-'+scope).forEach(cb=>{ cb.checked = false; });
  updateBulkBar(scope);
}
// Called by each render with the ids it just drew — updates the "select all" state and drops selections that
// scrolled out of the current filter.
function bulkSyncAfterRender(scope, visibleIds){
  bulkVisible[scope] = visibleIds;
  const vis = new Set(visibleIds);
  [...bulkSel[scope]].forEach(id=>{ if(!vis.has(id)) bulkSel[scope].delete(id); });
  updateBulkBar(scope);
}
function syncBulkHeader(scope){
  const h = document.getElementById('bulkAll-'+scope);
  if(!h) return;
  const total = bulkVisible[scope].length;
  const sel = bulkVisible[scope].filter(id=>bulkSel[scope].has(id)).length;
  h.checked = total>0 && sel===total;
  h.indeterminate = sel>0 && sel<total;
}
function bulkAssignOptions(scope){
  const days = (scope==='sup') ? supEditableDays() : (trainingConfig.dates||[]).slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  let html = `<option value="">— Assign selected to… —</option><optgroup label="Training Days">`;
  days.forEach(d=>{
    if(scope==='trainer'){ html += `<option value="date:${d.id}">${assignOptionLabel(d, false, true)}</option>`; return; }
    const passed = (scope==='sup' && isDeadlinePassed(d)) ? ' (Deadline passed)' : '';
    const hidden = d.active===false ? ' 🚫' : '';
    html += `<option value="date:${d.id}">${d.isOnline?'🌐 ':''}${esc(dayGroupText(d))}${passed}${hidden}</option>`;
  });
  html += `</optgroup><optgroup label="Other Status">`;
  LEAVE_STATUSES.forEach(s=>{ html += `<option value="leave:${esc(s)}">${esc(s)}</option>`; });
  html += `</optgroup><option value="__none__">Not Assigned (unassign)</option>`;
  return html;
}
function updateBulkBar(scope){
  if(scope==='sup' && typeof onSupSelectionChange==='function') onSupSelectionChange();   // enables "Request Change"
  const bar = document.getElementById('bulkBar-'+scope);
  if(!bar) return;
  const n = bulkSel[scope].size;
  if(!n){ bar.classList.remove('show'); bar.innerHTML=''; syncBulkHeader(scope); return; }
  if(bar.classList.contains('show')){
    // already built — just update the count so we don't reset the user's dropdown choice
    const c = bar.querySelector('.bulk-count'); if(c) c.textContent = n+' selected';
    syncBulkHeader(scope);
    return;
  }
  let html = `<span class="bulk-count">${n} selected</span>`;
  if(scope==='days'){
    html += `<button class="btn btn-outline btn-sm" onclick="bulkDays('hide')">${EYE_OFF_SVG} Hide</button>`
          + `<button class="btn btn-outline btn-sm" onclick="bulkDays('unhide')">👁 Unhide</button>`
          + `<button class="btn btn-outline btn-sm" onclick="openBulkDaysModal('deadline')">⏰ Deadline</button>`
          + `<button class="btn btn-outline btn-sm" onclick="openBulkDaysModal('supervisors')">👥 Supervisors</button>`
          + `<button class="btn btn-outline btn-sm" onclick="openBulkDaysModal('capacity')">🔢 Capacity</button>`
          + `<button class="btn btn-outline btn-sm" onclick="openBulkDaysModal('staff')">🧑‍🏫 Trainer / Coordinator</button>`
          + `<button class="btn btn-outline btn-sm" onclick="openBulkDaysModal('city')">🏙 City</button>`
          + `<button class="btn btn-danger btn-sm" onclick="bulkDays('delete')">🗑 Delete</button>`;
  } else {
    html += `<select id="bulkAssignSelect-${scope}">${bulkAssignOptions(scope)}</select>`
          + `<button class="btn btn-navy btn-sm" onclick="bulkApplyAssign('${scope}')">Apply</button>`;
    if(scope==='trainer') html += `<button class="btn btn-danger btn-sm" onclick="bulkDeletePharmacists()">🗑 Delete from roster</button>`;
  }
  html += `<button class="btn btn-outline btn-sm" onclick="bulkClear('${scope}')">Clear</button>`;
  bar.innerHTML = html;
  bar.classList.add('show');
  syncBulkHeader(scope);
}
function bulkApplyAssign(scope){
  if(scope==='sup') bulkApplySupAssign();
  else bulkApplyTrainerAssign();
}
function distinctArrayValues(list, key){
  const set = new Set();
  list.forEach(d=>(d[key]||[]).forEach(v=>{
    const t = (v||'').toString().trim();
    if(t && t!=='-' && t!=='—') set.add(t);
  }));
  return [...set].sort((a,b)=>a.localeCompare(b));
}

function isValidSupervisorName(n){
  const t = (n||'').trim();
  return !!t && t!=='-' && t!=='—';
}
function sortSupervisorNames(names){
  return names.slice().sort((a,b)=>{
    const aCC = (a||'').trim().toUpperCase()==='CC';
    const bCC = (b||'').trim().toUpperCase()==='CC';
    if(aCC && !bCC) return 1;
    if(bCC && !aCC) return -1;
    return a.localeCompare(b);
  });
}
function distinctValues(list, key){
  return [...new Set(list.map(p=>p[key]).filter(v=>{
    const t = (v||'').toString().trim();
    return !!t && t!=='-' && t!=='—';
  }))].sort((a,b)=>a.localeCompare(b));
}

/* Cascading filters: a filter only offers the values found among the rows that match the OTHER filters (pick an
   Area Manager and the Supervisor filter lists only that manager's supervisors). Each page registers, per table,
   the rows and how to read each filter's value(s) from a row; the table filtering itself is unchanged. Values
   already ticked stay listed so they can be unticked. With no other filter set, the full list shows as before. */
const FILTER_FACETS = {};   // scope -> { items: ()=>rows, values: { key: row=>[values] } }
const msFullOptions = {};   // scope_key -> the full option list the page built
function registerFilterFacets(scope, def){ FILTER_FACETS[scope] = def; }
function narrowMsOptions(scope, key, full){
  const def = FILTER_FACETS[scope];
  if(!def || !def.values[key]) return full;
  const st = filterStateFor(scope);
  const others = Object.keys(def.values).filter(k=>k!==key && st[k] && st[k].size);
  if(!others.length) return full;
  const present = new Set();
  def.items().forEach(it=>{
    if(others.every(k=>def.values[k](it).some(v=>st[k].has(v)))) def.values[key](it).forEach(v=>present.add(v));
  });
  return full.filter(o=>present.has(o.value) || st[key].has(o.value));
}
function msItemsHtml(scope, key, options){
  const state = filterStateFor(scope)[key];
  return options.map(o=>{
    const isChecked = state.has(o.value);
    return `<label class="ms-item${isChecked?' checked':''}" data-text="${esc(o.text.toLowerCase())}"><input type="checkbox" value="${esc(o.value)}" ${isChecked?'checked':''} onchange="onMsToggle('${scope}','${key}',this.value,this.checked);this.closest('.ms-item').classList.toggle('checked',this.checked);"><span>${esc(o.text)}</span></label>`;
  }).join('') || '<span class="small-note">No options</span>';
}
// After a filter changes, re-list the other filters of the same table (their panels are closed at that moment).
function refreshCascadingFilters(scope, changedKey){
  const def = FILTER_FACETS[scope];
  if(!def) return;
  Object.keys(def.values).forEach(key=>{
    if(key===changedKey) return;
    const list = document.getElementById('mslist_'+scope+'_'+key);
    const full = msFullOptions[scope+'_'+key];
    if(!list || !full) return;
    const shown = narrowMsOptions(scope, key, full);
    msOptionsCache[scope+'_'+key] = shown.map(o=>o.value);
    list.innerHTML = msItemsHtml(scope, key, shown);
  });
}

function renderMsFilter(scope, key, label, options){
  msFullOptions[scope+'_'+key] = options;
  options = narrowMsOptions(scope, key, options);
  msOptionsCache[scope+'_'+key] = options.map(o=>o.value);
  const state = filterStateFor(scope)[key];
  const count = state.size;
  const itemsHtml = msItemsHtml(scope, key, options);
  return `<div class="filter-field">
    <div class="ms-filter">
      <button type="button" class="btn${count?' active':''}" onclick="toggleMsPanel('${scope}_${key}')">
        <span class="fb-label">${esc(label)}</span>
        <span class="fb-count"${count?'':' style="display:none"'}>${count}</span>
        <span class="fb-arrow">▼</span>
      </button>
      <div class="ms-panel hidden" id="mspanel_${scope}_${key}">
        <div class="ms-search-wrap"><span>🔍</span><input type="text" class="ms-search" placeholder="Search…" oninput="filterMsList('${scope}_${key}', this.value)"></div>
        <div class="ms-list" id="mslist_${scope}_${key}">${itemsHtml}</div>
        <div class="ms-actions"><button type="button" onclick="msSelectAll('${scope}','${key}')">Select All</button><button type="button" onclick="msClearAll('${scope}','${key}')">Clear All</button></div>
      </div>
    </div>
  </div>`;
}
function filterMsList(id, query){
  const q = query.trim().toLowerCase();
  const list = document.getElementById('mslist_'+id);
  if(!list) return;
  list.querySelectorAll('.ms-item').forEach(item=>{
    const text = item.dataset.text || '';
    item.style.display = text.includes(q) ? '' : 'none';
  });
}
function toggleMsPanel(id){
  document.querySelectorAll('.ms-panel').forEach(p=>{
    if(p.id!=='mspanel_'+id){
      p.classList.add('hidden');
      const b = p.previousElementSibling;
      if(b) b.classList.remove('open');
    }
  });
  const el = document.getElementById('mspanel_'+id);
  if(el){
    const wasHidden = el.classList.contains('hidden');
    el.classList.toggle('hidden');
    const btn = el.previousElementSibling;
    if(btn) btn.classList.toggle('open', wasHidden);
  }
}
document.addEventListener('click', (e)=>{
  if(!e.target.closest('.ms-filter')) document.querySelectorAll('.ms-panel').forEach(p=>{
    p.classList.add('hidden');
    const b = p.previousElementSibling;
    if(b) b.classList.remove('open');
  });
});

function updateMsButtonLabel(scope,key){
  const state=filterStateFor(scope)[key];
  const panel = document.getElementById('mspanel_'+scope+'_'+key);
  if(!panel) return;
  const btn = panel.previousElementSibling;
  if(!btn) return;
  const count = state.size;
  const countEl = btn.querySelector('.fb-count');
  if(countEl){ countEl.textContent = count; countEl.style.display = count? '' : 'none'; }
  btn.classList.toggle('active', count>0);
}
function onMsToggle(scope,key,value,checked){
  const state=filterStateFor(scope)[key];
  if(checked) state.add(value); else state.delete(value);
  updateMsButtonLabel(scope,key);
  if(key==='date' && typeof renderConductedBySelect==='function') renderConductedBySelect();
  refreshCascadingFilters(scope, key);
  rerenderScope(scope);
}
function msSelectAll(scope,key){
  const state=filterStateFor(scope)[key];
  const opts = msOptionsCache[scope+'_'+key]||[];
  opts.forEach(v=>state.add(v));
  const panel = document.getElementById('mspanel_'+scope+'_'+key);
  if(panel) panel.querySelectorAll('.ms-item').forEach(item=>{
    const cb = item.querySelector('input[type=checkbox]');
    if(cb) cb.checked = true;
    item.classList.add('checked');
  });
  updateMsButtonLabel(scope,key);
  if(key==='date' && typeof renderConductedBySelect==='function') renderConductedBySelect();
  refreshCascadingFilters(scope, key);
  rerenderScope(scope);
}
function msClearAll(scope,key){
  const state=filterStateFor(scope)[key];
  state.clear();
  const panel = document.getElementById('mspanel_'+scope+'_'+key);
  if(panel) panel.querySelectorAll('.ms-item').forEach(item=>{
    const cb = item.querySelector('input[type=checkbox]');
    if(cb) cb.checked = false;
    item.classList.remove('checked');
  });
  updateMsButtonLabel(scope,key);
  if(key==='date' && typeof renderConductedBySelect==='function') renderConductedBySelect();
  refreshCascadingFilters(scope, key);
  rerenderScope(scope);
}
function inSet(value, set){ return set.size===0 || set.has(value); }
function matchesDateSet(pid, set){
  if(set.size===0) return true;
  const a = ops.assignments[pid];
  if(!a) return set.has('unassigned');
  if(a.type==='date') return set.has('date:'+a.dateId);
  if(a.type==='leave') return set.has('leave:'+a.status);
  return false;
}

// `marks` (trainer-side lists): 👁 after a visible day, 🚫 after one hidden from supervisors.
function dateFilterOptions(days, short, marks){
  if(marks===undefined) marks = !!short;
  const mark = d=> !marks ? (d.active===false?' 🚫':'') : (d.active===false?' 🚫':' 👁');
  return days.map(d=>({value:'date:'+d.id, text: (short ? shortDayText(d) : dayGroupText(d))+mark(d)}))
    .concat(LEAVE_STATUSES.map(s=>({value:'leave:'+s, text:s})))
    .concat([{value:'unassigned', text:'Not Assigned'}]);
}

/* ═══════════════════════════════ SORTING ═══════════════════════════════ */
let sortState = { sup:{key:null,dir:1}, trainer:{key:null,dir:1}, master:{key:null,dir:1} };
function toggleSort(scope,key){
  const st = sortState[scope];
  if(st.key===key) st.dir*=-1; else { st.key=key; st.dir=1; }
  rerenderScope(scope);
}
function getSortValue(p, key){
  if(key==='workShift') return ((ops.shifts&&ops.shifts[p.id])||'').toLowerCase();
  if(key==='attempt') return retrainHistory(p.id).length;
  if(key==='date'){
    const a = ops.assignments[p.id];
    if(!a) return 'zzz_unassigned';
    if(a.type==='leave') return 'zz_leave_'+a.status;
    const day = dayById(a.dateId);
    return day ? day.date : 'zzzz_deleted';
  }
  if(key==='attendance'){
    const s = attSummary(p.id, p);
    return s.status ? s.status + '_' + (s.punctuality||'') : '';
  }
  if(key==='core' || key==='capsule') return courseSlotSortValue(p, key);
  return (p[key]||'').toString().toLowerCase();
}
function applySort(scope, list){
  const st = sortState[scope];
  if(!st.key) return list;
  return [...list].sort((a,b)=>{
    const va = getSortValue(a, st.key), vb = getSortValue(b, st.key);
    if(va<vb) return -1*st.dir;
    if(va>vb) return 1*st.dir;
    return 0;
  });
}
function updateSortIndicators(scope){
  document.querySelectorAll(`[id^="sort-${scope}-"]`).forEach(el=>{
    const key = el.id.replace(`sort-${scope}-`,'');
    const st = sortState[scope];
    el.textContent = st.key===key ? (st.dir===1?'▲':'▼') : '';
  });
}

/* ═══════════════════════════════ SUPERVISOR VIEW ═══════════════════════════════ */
let currentSupervisor = null;

function isDeadlinePassed(day){
  if(!day.deadline) return false;
  const dl = new Date(day.deadline);
  if(isNaN(dl)) return false;
  return new Date() > dl;
}

/* The label shown for one training-day option — kept as a single helper so the collapsed (lazy) option and the
   fully-expanded list can never drift apart. */
// Hidden days only ever reach this on the trainer page (supervisors never get them in their lists), so the marker
// just tells the trainer which days supervisors can't see — the day stays fully usable.
// `short`: the trainer's Attendance tab uses the compact "Online QAS - 11,12 Oct 26" label (see shortDayText).
function assignOptionLabel(d, enforceDeadline, short){
  if(short) return `${esc(shortDayText(d))}${d.active===false?' 🚫':' 👁'}`;
  const passed = enforceDeadline && isDeadlinePassed(d);
  return `${d.isOnline?'🌐 ':''}${esc(dayGroupText(d))}${passed?' (Deadline passed)':''}${d.active===false?' 🚫':''}`;
}
function assignmentOptionsHtml(pid, days, enforceDeadline, short){
  const current = ops.assignments[pid];
  let html = `<option value="" ${!current?'selected':''}>-- Not Assigned --</option>`;
  html += `<optgroup label="Training Days">`;
  days.forEach(d=>{
    const val = 'date:'+d.id;
    const sel = current && current.type==='date' && current.dateId===d.id ? 'selected' : '';
    const passed = enforceDeadline && isDeadlinePassed(d);
    html += `<option value="${val}" ${sel} ${passed?'disabled':''}>${assignOptionLabel(d, enforceDeadline, short)}</option>`;
  });
  html += `</optgroup><optgroup label="Other Status">`;
  LEAVE_STATUSES.forEach(s=>{
    const val = 'leave:'+s;
    const sel = current && current.type==='leave' && current.status===s ? 'selected' : '';
    html += `<option value="${val}" ${sel}>${s}</option>`;
  });
  html += `</optgroup>`;
  return html;
}

/* The single <option> a collapsed (not-yet-opened) assignment <select> shows. It mirrors exactly what the full
   option list above would display as the selected value, so filling the rest of the list on open changes nothing
   the user sees. */
function currentAssignOptionHtml(pid, relevantDays, enforceDeadline, short){
  const a = ops.assignments[pid];
  if(a && a.type==='date'){
    const d = relevantDays.find(x=>x.id===a.dateId);
    if(d){
      const passed = enforceDeadline && isDeadlinePassed(d);
      return `<option value="date:${d.id}" selected${passed?' disabled':''}>${assignOptionLabel(d, enforceDeadline, short)}</option>`;
    }
  } else if(a && a.type==='leave'){
    return `<option value="leave:${esc(a.status)}" selected>${esc(a.status)}</option>`;
  }
  return `<option value="" selected>-- Not Assigned --</option>`;
}

/* Fills the full day list into an assignment <select> the first time it is opened. Rendering every row's dropdown
   with all training days up front created tens of thousands of <option> nodes (one dropdown per row × every day);
   rendering one option per select and expanding on demand keeps the table light without changing the control. */
function fillAssignSelect(sel){
  if(sel.dataset.filled) return;
  sel.dataset.filled = '1';
  const pid = sel.dataset.pid;
  const fn = sel.dataset.fn;
  const online = sel.dataset.online === '1';
  const enforceDeadline = fn === 'onAssignChange';
  // supervisor page: only the days this supervisor may pick for this pharmacist (supAssignableDays, supervisor.js)
  // trainer (Attendance tab): every day, in date order
  const src = (fn === 'onAssignChange') ? supAssignableDays(pid) : trainingConfig.dates.slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const relevantDays = src.filter(d => !!d.isOnline === online);
  const cur = sel.value;
  const curText = sel.selectedIndex>=0 ? sel.options[sel.selectedIndex].text : '';
  sel.innerHTML = assignmentOptionsHtml(pid, relevantDays, enforceDeadline, fn === 'onTrainerAssignChange');
  // the current choice isn't offered again (e.g. the day a pharmacist missed) — keep showing it, but not selectable
  if(cur && ![...sel.options].some(o=>o.value===cur)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(cur)}" disabled>${esc(curText)}</option>`);
  if(sel.value !== cur) sel.value = cur;
}

function dateCellHtml(p, editable, days, changeFn){
  const a = ops.assignments[p.id];
  let badge;
  if(!a){
    badge = `<span class="badge badge-empty">Not Assigned</span>`;
  } else if(a.type==='leave'){
    badge = `<span class="badge badge-leave">${esc(a.status)}</span>`;
  } else {
    const day = dayById(a.dateId);
    if(!day){
      badge = `<span class="badge badge-empty">Not Assigned</span>`;
    } else if(a.overQuota && !a.quotaApproved){
      const txt = changeFn==='onTrainerAssignChange' ? shortDayText(day) : dayGroupText(day);
      badge = `<span class="badge" style="background:var(--pending-bg);color:var(--pending);border:1px solid var(--pending);">⏳ Pending Quota Approval — ${esc(txt)}</span>`;
    } else if(changeFn==='onTrainerAssignChange'){
      badge = `<span class="badge badge-date">${esc(shortDayText(day))}</span>`;
    } else {
      badge = `<span class="badge badge-date">${day.isOnline?'🌐 ':''}${esc(dayGroupText(day))}</span>`;
    }
  }
  const retrain = retrainNoteHtml(p, changeFn==='onTrainerAssignChange');
  if(!editable) return badge + retrain;
  const enforceDeadline = changeFn==='onAssignChange';
  const relevantDays = days.filter(d => !!d.isOnline === isOnlinePharmacist(p));
  const collapsed = currentAssignOptionHtml(p.id, relevantDays, enforceDeadline, changeFn==='onTrainerAssignChange');
  return `<div>${badge}<br><select class="assign-select" data-pid="${p.id}" data-fn="${changeFn}" data-online="${isOnlinePharmacist(p)?1:0}" onfocus="fillAssignSelect(this)" onmousedown="fillAssignSelect(this)" onchange="${changeFn}('${p.id}', this.value)">${collapsed}</select>${retrain}</div>`;
}

/* ═══════════════════════════════ RETRAINING (v4) ═══════════════════════════════
   A pharmacist who missed their training (Absent, or Partial on a 2-day training) and is booked again — by the
   training team or their supervisor — keeps the missed attempt: the server moves it into ops.history[pid]
   ({dateId, date, label, status, reason, endedAt, endedBy}) instead of throwing it away. The next booked day is a
   re-training ("Retraining #2", #3 …) and everyone sees the date they originally missed. */
/* Request Data Edit (supervisor → trainer approval): the pharmacist details a supervisor may ask to correct.
   `hidden` = not sent to supervisors (they can type a new value but don't see the current one). "City" also carries
   Physical ↔ Online (an online pharmacist's city is "Online"). Supervisor, Area Manager and District stay trainer-only. */
const DATA_EDIT_FIELDS = [
  {key:'displayName', label:'Pharmacist Name'}, {key:'email', label:'Email'}, {key:'pharmacyNo', label:'Pharmacy No.'},
  {key:'employeeId', label:'Employee ID', hidden:true}, {key:'phone', label:'Phone', hidden:true}, {key:'scfhs', label:'SCFHS', hidden:true},
  {key:'city', label:'City / Online-Physical'}
];

function retrainHistory(pid){ return (ops.history && ops.history[pid]) || []; }
function retrainKey(p){ return retrainHistory(p.id).length ? 'retraining' : 'first'; }
const RETRAIN_FILTER_OPTIONS = [{value:'retraining', text:'↻ Retraining'}, {value:'first', text:'First attempt'}];
function attemptDayText(h, short){
  const d = dayById(h.dateId);
  return d ? (short ? shortDayText(d) : dayGroupText(d)) : (h.label || (h.date ? formatDate(h.date) : 'a deleted day'));
}
function retrainNoteHtml(p, trainerSide){
  const h = retrainHistory(p.id);
  if(!h.length) return '';
  const a = ops.assignments[p.id];
  const first = h[0];
  const missed = trainerSide
    ? `missed ${attemptDayText(first, true)}${first.status==='Partial' ? ' (partial)' : ''}`
    : `originally ${first.status==='Partial' ? 'partial' : 'absent'} on ${attemptDayText(first, false)}`;
  const text = a && a.type==='date' ? `↻ Retraining #${h.length+1} — ${missed}` : `↻ Missed training ${h.length}× — ${missed}`;
  return `<div class="retrain-badge" role="button" tabindex="0" title="Show every attempt" onclick="openRetrainHistory('${p.id}')" onkeydown="if(event.key==='Enter'){openRetrainHistory('${p.id}')}">${esc(text)}</div>`;
}
function openRetrainHistory(pid){
  const p = masterData.find(m=>m.id===pid);
  const h = retrainHistory(pid);
  const trainerSide = typeof isCoordinatorRole==='function';
  const when = s=> s ? new Date(s).toLocaleString('en-GB',{dateStyle:'medium', timeStyle:'short'}) : '—';
  const a = ops.assignments[pid];
  let current = 'Not Assigned', currentStatus = '—';
  if(a && a.type==='leave') current = a.status;
  if(a && a.type==='date'){ const d = dayById(a.dateId); current = d ? (trainerSide ? shortDayText(d) : dayGroupText(d)) : '—'; currentStatus = p ? (attSummary(pid,p).status || (attSummary(pid,p).inProgress ? 'In progress' : 'Not marked yet')) : '—'; }
  showModal(`<h3>Training attempts — ${esc(p ? p.displayName : '')}</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Training day</th><th>Result</th><th>Reason</th><th>Moved on</th><th>By</th></tr></thead>
      <tbody>${h.map((x,i)=>`<tr><td>${i+1}</td><td class="no-truncate">${esc(attemptDayText(x, trainerSide))}</td><td><span class="badge ${x.status==='Partial'?'badge-leave':'badge-danger'}">${esc(x.status||'Absent')}</span></td><td>${esc(x.reason||'—')}</td><td style="white-space:nowrap">${esc(when(x.endedAt))}</td><td>${esc(x.endedBy||'—')}</td></tr>`).join('')}
        <tr class="retrain-current"><td>${h.length+1}</td><td class="no-truncate">${esc(current)} <span class="small-note">(now)</span></td><td>${esc(currentStatus)}</td><td>—</td><td>—</td><td>—</td></tr>
      </tbody>
    </table></div>
    <div class="modal-actions"><button class="btn btn-navy btn-sm" onclick="closeModal()">Close</button></div>`, 'max-width:760px;');
}

/* Adherence Rate = attended ÷ invited, counting every invitation: each time a pharmacist was booked on a training day
   that has already been held (first attempt or retraining) counts once. Future bookings and over-quota bookings
   still awaiting approval don't count yet. Partial attendance is not "attended". */
function adherenceStats(list){
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  let invited = 0, attended = 0;
  list.forEach(p=>{
    retrainHistory(p.id).forEach(x=>{ if(!x.date || x.date<=today) invited++; });
    const a = ops.assignments[p.id];
    if(a && a.type==='date' && !(a.overQuota && !a.quotaApproved)){
      const d = dayById(a.dateId);
      if(d && d.date && d.date<=today){ invited++; if(hasAttendedTraining(p)) attended++; }
    }
  });
  return {invited, attended, rate: invited ? Math.round(attended/invited*1000)/10 : null};
}

function hasValidDateAssignment(p){
  const a = ops.assignments[p.id];
  if(!a || a.type!=='date') return false;
  return !!dayById(a.dateId);
}
function assignedDayForPerson(p){
  const a = ops.assignments[p.id];
  if(!a || a.type!=='date') return null;
  return dayById(a.dateId);
}
function isSplitPerson(p){
  const day = assignedDayForPerson(p);
  return !!(day && day.isOnline && day.onlineFormat==='split');
}
// Normalizes attendance for both regular (single-status) and split (day1/day2) assignments.
// Returns {status: 'Attended'|'Absent'|'Partial'|undefined, punctuality, missingDay, inProgress, day1, day2}
// Split trainings (same rule as the server's isFailed): one day attended + the other marked Absent = Partial;
// any day Absent and none attended = Absent; Day 1 attended with Day 2 not marked yet = still in progress (not failed).
function attSummary(pid, p){
  const att = ops.attendance[pid];
  if(!att) return {status: undefined};
  if(p && isSplitPerson(p)){
    const s1 = att.day1 && att.day1.status;
    const s2 = att.day2 && att.day2.status;
    if(s1==='Attended' && s2==='Attended'){
      const punct = (att.day1.punctuality==='Late' || att.day2.punctuality==='Late') ? 'Late' : 'On Time';
      return {status:'Attended', punctuality:punct, day1:s1, day2:s2};
    }
    const r1 = s1==='Absent' ? (att.day1.reason||'') : '', r2 = s2==='Absent' ? (att.day2.reason||'') : '';
    const reason = [...new Set([r1,r2].filter(Boolean))].join(' / ');
    const attendedOne = s1==='Attended' || s2==='Attended', absentOne = s1==='Absent' || s2==='Absent';
    if(attendedOne && absentOne) return {status:'Partial', missingDay: s1==='Absent'?1:2, reason, day1:s1, day2:s2};
    if(absentOne) return {status:'Absent', reason, day1:s1, day2:s2};
    if(attendedOne) return {status: undefined, inProgress:true, day1:s1, day2:s2};
    return {status: undefined};
  }
  return {status: att.status, punctuality: att.punctuality, reason: att.status==='Absent' ? (att.reason||'') : ''};
}
// Fully attended (both days, for a split online training). Once true, supervisors can no longer change the
// pharmacist's assignment — only the training team can (enforced on the server too).
function hasAttendedTraining(p){
  return attSummary(p.id, p).status==='Attended';
}
/* The three "Pharmacist status" cards (supervisor page, and the trainer's Analytics & Export tab). Clicking a card
   filters the table below it to that group; clicking it again (or ✕ / Clear Filters) shows everyone again. The
   rules here are the ones the card counts use, so a card's number always equals the rows it filters to. */
const STATUS_GROUPS = {
  attended:    {title:'Attended',            test:p=>hasAttendedTraining(p)},
  notAssigned: {title:'Not Assigned',        test:p=>!ops.assignments[p.id]},
  absent:      {title:'Assigned but Absent', test:p=>ops.assignments[p.id]?.type==='date' && attSummary(p.id,p).status==='Absent'}
};
function statusCardHtml(kind, cls, inner, activeKind, onClickFn){
  const active = activeKind===kind;
  const call = `${onClickFn}('${kind}')`;
  return `<div class="chip chip-lg chip-status ${cls} chip-click${active?' chip-active':''}" role="button" tabindex="0" aria-pressed="${active}" title="${active?'Show everyone again':'Show only these pharmacists in the table below'}" onclick="${call}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${call};}">${inner}<div class="chip-more">${active?'✓ Filtering the table — click to clear':'Filter the table ›'}</div></div>`;
}
function statusFilterTagHtml(kind, clearFn){
  if(!kind) return '';
  return `<span class="status-filter-tag">Showing: ${esc(STATUS_GROUPS[kind].title)} <button type="button" title="Show everyone" onclick="${clearFn}(null)">✕</button></span>`;
}
// Attendance as the supervisor sees it in their Pharmacist List.
function attendanceBadgeHtml(p){
  const a = ops.assignments[p.id];
  if(!a || a.type!=='date' || !dayById(a.dateId)) return '<span class="small-note">—</span>';
  if(a.overQuota && !a.quotaApproved) return '<span class="small-note">—</span>';
  const s = attSummary(p.id, p);
  if(s.status==='Attended') return `<span class="badge badge-att-ok">✔ Attended — ${esc(s.punctuality||'On Time')}</span>`;
  if(s.status==='Absent') return `<span class="badge badge-danger">✕ Absent${s.reason?' — '+esc(s.reason):''}</span>`;
  if(s.status==='Partial') return `<span class="badge badge-leave">Partial — Day ${s.missingDay} missing${s.reason?' ('+esc(s.reason)+')':''}</span>`;
  if(s.inProgress) return `<span class="badge badge-empty">Day 1 attended — Day 2 not marked yet</span>`;
  return `<span class="badge badge-empty">Not marked yet</span>`;
}
function isOnlinePharmacist(p){
  return (p.city||'').trim().toLowerCase()==='online';
}
function cityCellHtml(p){
  if(isOnlinePharmacist(p)){
    return `<span class="city-badge online">Online</span>`;
  }
  return p.city ? `<span class="city-badge">${esc(p.city)}</span>` : '—';
}
/* ── Core / Capsule completion cells (v5) — read from the published course data (courseSlots), matched by email ──
   Finished (Completed, or final video done) → "✔ 5 Oct 26", red when it was after the pharmacist's training day;
   "✔ Completed (no date)" when the time is unknown · in progress → bar + % · no data → "—". */
function courseSlotEntry(p, slot){
  const s = courseSlots && courseSlots[slot];
  if(!s || !s.byEmail) return null;
  return s.byEmail[String(p.email||'').trim().toLowerCase()] || null;
}
// KSA calendar date (YYYY-MM-DD) of an ISO time, and its "5 Oct 26" form
function ksaDateIso(iso){ const d = new Date(Date.parse(iso) + 3*3600*1000); return isNaN(d) ? '' : d.toISOString().slice(0,10); }
function ksaDateText(iso){
  const d = new Date(Date.parse(iso) + 3*3600*1000);
  return isNaN(d) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0,3)} ${String(d.getUTCFullYear()).slice(-2)}`;
}
// Finished after the training day they were booked on (day 1 of a 2-day training). Unassigned / on leave → never.
function finishedAfterTrainingDay(p, e){
  if(!e || !e.f) return false;
  const a = ops.assignments[p.id];
  if(!a || a.type!=='date') return false;
  const day = dayById(a.dateId);
  return !!(day && day.date && ksaDateIso(e.f) > day.date);
}
function completionBarHtml(r){
  const n = Math.round(Number(r)*10)/10;
  if(!isFinite(n)) return '<span class="small-note">—</span>';
  const clamped = Math.max(0, Math.min(100, n));
  const color = n>=100 ? 'var(--navy)' : 'var(--blue)';
  return `<div class="compl-cell">
      <div class="compl-bar-track"><div class="compl-bar-fill" style="width:${clamped}%;background:${color};"></div></div>
      <span class="compl-pct-text" style="color:${color};">${n}%</span>
    </div>`;
}
function courseSlotCellHtml(p, slot){
  const e = courseSlotEntry(p, slot);
  if(!e) return '<span class="small-note">—</span>';
  if(e.d){
    if(!e.f) return '<span class="slot-done">✔ Completed (no date)</span>';
    const late = finishedAfterTrainingDay(p, e);
    return `<span class="slot-done${late?' late':''}"${late?' title="Finished after the training day"':''}>✔ ${esc(ksaDateText(e.f))}</span>`;
  }
  return completionBarHtml(e.r);
}
// Supervisor page: the percentage only (that is all the server sends a supervisor)
function courseSlotPctHtml(p, slot){
  const e = courseSlotEntry(p, slot);
  return e ? completionBarHtml(e.r) : '<span class="small-note">—</span>';
}
// Export text: "Completed 5 Oct 26" / "Completed (no date)" / "45%" / blank
function courseSlotText(p, slot){
  const e = courseSlotEntry(p, slot);
  if(!e) return '';
  if(e.d) return e.f ? 'Completed '+ksaDateText(e.f) : 'Completed (no date)';
  return (Math.round(Number(e.r)*10)/10)+'%';
}
// Sort (ascending): finished with a date (earliest first) → finished without a date → in progress (highest % first) → no data
function courseSlotSortValue(p, slot){
  const e = courseSlotEntry(p, slot);
  if(!e) return 3e15;
  if(e.d) return e.f ? Date.parse(e.f) : 1e15;
  return 2e15 + (100 - (Number(e.r)||0)) * 1e10;
}
function courseSlotHeaderTitle(slot){
  const s = courseSlots && courseSlots[slot];
  const label = slot==='core' ? 'Core' : 'Capsule';
  if(!s) return `${label}: no course chosen yet (Reports Configuration → Hub columns)`;
  return `${label} = ${s.name}` + (s.lastPublishedAt ? ` · published ${ksaDateText(s.lastPublishedAt)}` : ' · not published yet');
}
function attendanceStatusText(p){
  const s = attSummary(p.id, p);
  if(s.inProgress) return 'Day 1 attended - Day 2 not marked yet';
  if(!s.status) return 'Not Assigned';
  if(s.status==='Attended'){
    if(isSplitPerson(p)) return 'Attended (both days) - ' + s.punctuality;
    const att = ops.attendance[p.id];
    return 'Attended - ' + s.punctuality + (s.punctuality==='Late' && att.time ? ' ('+att.time+')' : '');
  }
  if(s.status==='Partial'){
    return `Partial — Day ${s.missingDay} missing (make-up needed)${s.reason?' - '+s.reason:''}`;
  }
  if(s.status==='Absent' && s.reason) return 'Absent - '+s.reason;
  return s.status;
}

// Two training days can share a city and date (e.g. online "Mix 3" and "Mix 4" both starting 5 Oct), which makes their
// "City — date" text identical. Only in that case the training name is added, so the Date text — in the tables, the
// exports, and an Excel re-upload — points at exactly one day.
let _dupDayCount = null, _dupDaySrc = null, _dupDayLen = -1;
function daysShareCityAndDate(day){
  const arr = trainingConfig.dates || [];
  if(_dupDaySrc!==arr || _dupDayLen!==arr.length){
    _dupDayCount = {};
    arr.forEach(d=>{ const k = d.city+'|'+dayDateLabel(d); _dupDayCount[k] = (_dupDayCount[k]||0)+1; });
    _dupDaySrc = arr; _dupDayLen = arr.length;
  }
  return _dupDayCount[day.city+'|'+dayDateLabel(day)]>1;
}
function dayDisambiguator(day){
  return (daysShareCityAndDate(day) && day.trainingName) ? ` (${day.trainingName})` : '';
}
// How a training day reads in dropdowns, filters, badges and chips (plain text — callers escape it). Separate groups
// that share a city and date (e.g. "Online QAS" for one supervisor, "Online North" for another, both 6 - 7 Oct) would
// otherwise read identically, so those show their group name and the supervisor(s) they belong to.
function dayGroupText(d){
  if(!daysShareCityAndDate(d)) return `${d.city} — ${dayDateLabel(d)}`;
  const sups = d.visibleSupervisors || [];
  const who = !sups.length ? 'no supervisor yet' : (sups.length<=2 ? sups.join(', ') : sups.length+' supervisors');
  return `${d.trainingName || d.city} — ${dayDateLabel(d)} · ${who}`;
}
// Short "City - date" label for the trainer's Attendance tab dropdowns and Date filter:
// "Online QAS - 11,12 Oct 26", "Online - 8,9 Nov 26", "Jeddah - 5 Oct 26". Online days use their training name
// (the group), in-person days their city. Only when two days would still read the same is a supervisor hint added.
function compactDayDate(day){
  const d1 = new Date(day.date+'T00:00:00');
  if(isNaN(d1)) return day.date || '';
  const mon = m=>MONTHS[m].slice(0,3), yy = String(d1.getFullYear()).slice(-2);
  if(!(day.isOnline && day.onlineFormat==='split')) return `${d1.getDate()} ${mon(d1.getMonth())} ${yy}`;
  const d2 = new Date(d1); d2.setDate(d2.getDate()+1);
  if(d1.getMonth()===d2.getMonth()) return `${d1.getDate()},${d2.getDate()} ${mon(d1.getMonth())} ${yy}`;
  return `${d1.getDate()} ${mon(d1.getMonth())},${d2.getDate()} ${mon(d2.getMonth())} ${yy}`;
}
function shortDayBase(d){
  const name = d.isOnline ? (d.trainingName || d.city || 'Online') : (d.city || d.trainingName || '');
  return `${name} - ${compactDayDate(d)}`;
}
let _shortDupCount = null, _shortDupSrc = null, _shortDupLen = -1;
function shortDayText(d){
  const arr = trainingConfig.dates || [];
  if(_shortDupSrc!==arr || _shortDupLen!==arr.length){
    _shortDupCount = {};
    arr.forEach(x=>{ const k = shortDayBase(x); _shortDupCount[k] = (_shortDupCount[k]||0)+1; });
    _shortDupSrc = arr; _shortDupLen = arr.length;
  }
  const base = shortDayBase(d);
  if(!(_shortDupCount[base]>1)) return base;
  const sups = d.visibleSupervisors || [];
  return `${base} · ${!sups.length ? 'no supervisor' : (sups.length<=2 ? sups.join(', ') : sups.length+' supervisors')}`;
}

// Why an absent pharmacist missed the training — required when marking Absent.
const ABSENT_REASONS = ['Interaction','Pharmacy','LMS'];
function absentReasonFromText(text){
  const n = String(text||'').toLowerCase();
  return ABSENT_REASONS.find(r=>new RegExp('\\b'+r.toLowerCase()+'\\b').test(n)) || '';
}

// City Roster (General Configurations): the cities offered for training days, each optionally linked to the
// supervisor(s) it belongs to. Cities already used by pharmacists or training days are always offered too.
function cityRosterList(){ return Array.isArray(trainingConfig.cityRoster) ? trainingConfig.cityRoster : []; }
function allKnownCities(){
  const set = new Set(cityRosterList().map(c=>c.name).filter(Boolean));
  masterData.forEach(p=>{ if(p.city) set.add(p.city); });
  (trainingConfig.dates||[]).forEach(d=>{ if(d.city) set.add(d.city); });
  return [...set].sort((a,b)=>a.localeCompare(b));
}
function citySupervisorsFromRoster(city){
  const c = cityRosterList().find(x=>x.name===city);
  return c && Array.isArray(c.supervisors) ? c.supervisors.slice() : [];
}

function buildMasterRow(p){
  const a = ops.assignments[p.id];
  const att = ops.attendance[p.id];
  let dateText = 'Not Assigned', conductedBy = '', statusText = 'Not Assigned', validDateAssignment = false;
  if(a && a.type==='date'){
    const day = dayById(a.dateId);
    if(day){
      dateText = day.city+' — '+dayDateLabel(day)+dayDisambiguator(day);
      conductedBy = (day.trainerNames||[]).join(', ');
      statusText = attendanceStatusText(p);
      validDateAssignment = true;
    }
  } else if(a && a.type==='leave'){
    dateText = a.status;
    statusText = a.status;
  }
  return {
    district:p.district||'', areaManager:p.areaManager||'', city:p.city||'', supervisor:p.supervisor||'',
    dateText, conductedBy,
    pharmacyNo:p.pharmacyNo||'', employeeId:p.employeeId||'', email:p.email||'', displayName:p.displayName||'',
    phone:p.phone||'', scfhs:p.scfhs||'',
    // Core / Capsule completion as export text (v5, from the published course data)
    completionPct: courseSlotText(p, 'core'),
    capsulePct: courseSlotText(p, 'capsule'),
    statusText,
    workShift: (ops.shifts && ops.shifts[p.id]) || '',
    // Retraining: the training day originally missed, and which attempt the current booking is (blank = first attempt)
    originalDate: retrainHistory(p.id).length ? attemptDayText(retrainHistory(p.id)[0]) : '',
    attempt: retrainHistory(p.id).length ? String(retrainHistory(p.id).length + (a && a.type==='date' ? 1 : 0)) : '',
    note: p.note || (validDateAssignment && att && att.note ? att.note : ''),
    markedBy: validDateAssignment && att ? (att.markedBy || (att.day1&&att.day1.markedBy) || (att.day2&&att.day2.markedBy) || '') : ''
  };
}

/* ═══════════════════════════════ STYLED XLSX WRITER (real colors, matches reference workbook) ═══════════════════════════════
   SheetJS's free build cannot write cell colors/fills — only the Pro version can.
   This builds a minimal valid .xlsx package by hand (via JSZip) with real styling:
   navy header row with white bold text, alternating white/light-blue row bands,
   thin light borders, matching the reference "Selling Opportunities" workbook look. */
function xlsxColLetter_(n){
  let s = '', num = n+1;
  while(num>0){ const rem=(num-1)%26; s = String.fromCharCode(65+rem)+s; num = Math.floor((num-1)/26); }
  return s;
}
function xmlEsc_(v){
  return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function buildStylesXml_(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FF1A2B45"/><name val="Calibri"/></font>
</fonts>
<fills count="10">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF003261"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF0F5FB"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC6E0B4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF4CCCC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDE7F6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFDCE4EF"/></left><right style="thin"><color rgb="FFDCE4EF"/></right><top style="thin"><color rgb="FFDCE4EF"/></top><bottom style="thin"><color rgb="FFDCE4EF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="9" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}
/* Status cell coloring: Attended=green(4), Sick Leave=yellow(5), Resignation=red(6), everything else (incl. Not Assigned) = default zebra */
function statusCellStyle_(value){
  const v = String(value||'');
  if(v.indexOf('Attended')===0) return 4;
  if(v==='Sick Leave') return 5;
  if(v==='Resignation') return 6;
  if(v==='Absent') return 6;
  // course completion (Reports): finished green · in progress yellow · not started red · not in roster grey · no data lavender
  if(v==='Completed' || v==='Final video done, others missing') return 4;
  if(v==='In progress') return 5;
  if(v==='Not started') return 6;
  if(v==='Not in roster') return 7;
  if(v==='No completion data') return 8;
  return null;
}
function computeAutoColWidths_(headers, rows){
  return headers.map((h,i)=>{
    let max = String(h).length;
    rows.forEach(r=>{
      const len = String(r[i]==null?'':r[i]).length;
      if(len>max) max = len;
    });
    return Math.min(Math.max(max+3, 9), 45);
  });
}
function buildSheetXml_(headers, rows, colWidths, opts, sheetIndex){
  opts = opts || {};
  // status colouring: one column (statusColIndex) or several (statusCols)
  const statusCols = new Set(opts.statusCols || (opts.statusColIndex!==undefined ? [opts.statusColIndex] : []));
  const autoFilter = !!opts.autoFilter;
  const numCols = headers.length;
  const numRows = rows.length + 1;
  const lastCol = xlsxColLetter_(numCols-1);
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${numRows}"/>
<sheetViews><sheetView ${sheetIndex ? '' : 'tabSelected="1" '}workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="20"/>
<cols>${colWidths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>`;
  xml += `<row r="1" ht="26" customHeight="1">` + headers.map((h,i)=>
    `<c r="${xlsxColLetter_(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${xmlEsc_(h)}</t></is></c>`).join('') + `</row>`;
  rows.forEach((row, ri)=>{
    const zebraStyle = (ri % 2 === 0) ? 2 : 3;
    const r = ri + 2;
    xml += `<row r="${r}" ht="20" customHeight="1">` + row.map((val,ci)=>{
      let styleIdx = zebraStyle;
      if(statusCols.has(ci)){
        const override = statusCellStyle_(val);
        if(override!==null) styleIdx = override;
      }
      // real numbers are written as numbers (sortable / summable in Excel); everything else as text
      if(typeof val==='number' && isFinite(val)) return `<c r="${xlsxColLetter_(ci)}${r}" s="${styleIdx}"><v>${val}</v></c>`;
      return `<c r="${xlsxColLetter_(ci)}${r}" s="${styleIdx}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc_(val)}</t></is></c>`;
    }).join('') + `</row>`;
  });
  xml += `</sheetData>`;
  if(autoFilter) xml += `<autoFilter ref="A1:${lastCol}1"/>`;
  xml += `</worksheet>`;
  return xml;
}
/* opts.autoName: use `filename` as given (no "save as" prompt).
   opts.sheets: several sheets — [{name, headers, rows, colWidths, opts}] — instead of the single sheet in the arguments. */
async function downloadStyledXlsx(filename, sheetName, headers, rows, colWidths, opts){
  opts = opts || {};
  if(typeof JSZip === 'undefined'){
    toast('Excel export library failed to load — check your connection and try again','err');
    return false;
  }
  if(!opts.autoName){
    const baseName = filename.replace(/\.xlsx$/i, '');
    const chosenName = await promptForFilename(baseName, 'xlsx');
    if(!chosenName) return false;
    filename = chosenName;
  }
  const sheets = (opts.sheets && opts.sheets.length) ? opts.sheets
    : [{name: sheetName, headers, rows, colWidths, opts}];
  // Excel sheet names: max 31 characters, none of : \ / ? * [ ], and unique
  const used = new Set();
  const sheetNames = sheets.map((s,i)=>{
    let n = String(s.name||('Sheet'+(i+1))).replace(/[:\\\/?*\[\]]/g,' ').trim().slice(0,31) || ('Sheet'+(i+1));
    while(used.has(n.toLowerCase())) n = n.slice(0,28)+' '+(i+1);
    used.add(n.toLowerCase());
    return n;
  });
  try{
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetNames.map((n,i)=>`<sheet name="${xmlEsc_(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file('xl/styles.xml', buildStylesXml_());
    sheets.forEach((s,i)=>{
      const sw = s.colWidths || computeAutoColWidths_(s.headers, s.rows);
      zip.file(`xl/worksheets/sheet${i+1}.xml`, buildSheetXml_(s.headers, s.rows, sw, s.opts||{}, i));
    });
    const blob = await zip.generateAsync({type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 5000);
    return true;
  }catch(e){
    console.error('Excel export error:', e);
    toast('Excel export failed: ' + (e && e.message ? e.message : 'unknown error'), 'err');
    return false;
  }
}

// Course-completion exports: "10 Oct 26 - 1 PM - <Course Name> - Moodle.xlsx" — local time, Windows-safe.
function reportFileName(courseName, source, ext, d){
  d = d || new Date(); ext = ext || 'xlsx';
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const stamp = `${d.getDate()} ${M[d.getMonth()]} ${String(d.getFullYear()).slice(-2)} - ${h} ${ap}`;
  const src = String(source).toLowerCase() === 'sap' ? 'SAP' : 'Moodle';
  const clean = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ')
                                    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  let base = `${stamp} - ${clean(courseName) || 'Course'} - ${src}`;
  if (base.length > 150) base = base.slice(0, 150).replace(/[. ]+$/, '');
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(base)) base = '_' + base;
  return `${base}.${ext}`;
}

/* ═══════════════════════════════ MODAL ═══════════════════════════════ */
function showModal(html, boxStyle){
  document.getElementById('modalRoot').innerHTML = `<div class="modal-overlay"><div class="modal-box" style="${boxStyle||''}">${html}</div></div>`;
}
function closeModal(){ document.getElementById('modalRoot').innerHTML=''; }

/* ═══════════════════════════════ EXPORTS (IMAGE / PDF) ═══════════════════════════════ */
// Scroll boxes (.table-scroll) are expanded while capturing, so the image/PDF holds the whole table.
/* ═══════════════════════════════ ALWAYS-REACHABLE SIDEWAYS SCROLLBAR ═══════════════════════════════
   A wide table's own left/right scrollbar sits at its bottom edge — often far below the screen (long lists), so you'd
   have to scroll through every row to reach it. While that edge is off-screen, a copy of the scrollbar is pinned to
   the bottom of the window, lined up with the table and kept in sync with it. It disappears once the table's own
   scrollbar comes into view (or the table fits). Applies to every table on the page. */
const _hbarWraps = [];
function attachFloatingScrollbar(wrap){
  if(wrap._hbar) return;
  const bar = document.createElement('div');
  bar.className = 'hscroll-proxy';
  bar.setAttribute('aria-hidden', 'true');
  bar.appendChild(document.createElement('div'));
  wrap.after(bar);
  wrap._hbar = bar;
  bar.addEventListener('scroll', ()=>{ if(wrap.scrollLeft!==bar.scrollLeft) wrap.scrollLeft = bar.scrollLeft; });
  wrap.addEventListener('scroll', ()=>{ if(bar.scrollLeft!==wrap.scrollLeft) bar.scrollLeft = wrap.scrollLeft; }, {passive:true});
  if(window.ResizeObserver){
    const ro = new ResizeObserver(scheduleFloatingScrollbars);
    ro.observe(wrap);
    const t = wrap.querySelector('table'); if(t) ro.observe(t);   // rows re-rendered → width may change
  }
  _hbarWraps.push(wrap);
}
function updateFloatingScrollbar(wrap){
  const bar = wrap._hbar;
  const r = wrap.getBoundingClientRect();
  const vh = window.innerHeight;
  // needed when the table is wider than its box and its bottom edge (with the real scrollbar) is below the window
  const needed = r.width>0 && wrap.scrollWidth > wrap.clientWidth+1 && r.top < vh-40 && r.bottom > vh;
  bar.style.display = needed ? 'block' : 'none';
  if(!needed) return;
  bar.style.left = r.left + 'px';
  bar.style.width = wrap.clientWidth + 'px';
  bar.firstChild.style.width = wrap.scrollWidth + 'px';
  if(bar.scrollLeft!==wrap.scrollLeft) bar.scrollLeft = wrap.scrollLeft;
}
let _hbarQueued = false;
function scheduleFloatingScrollbars(){
  if(_hbarQueued) return;
  _hbarQueued = true;
  requestAnimationFrame(()=>{ _hbarQueued = false; _hbarWraps.forEach(updateFloatingScrollbar); });
}
function initFloatingScrollbars(){
  document.querySelectorAll('main .table-wrap').forEach(attachFloatingScrollbar);
  window.addEventListener('scroll', scheduleFloatingScrollbars, {passive:true, capture:true});   // page and inner boxes
  window.addEventListener('resize', scheduleFloatingScrollbars);
  document.addEventListener('click', ()=>setTimeout(scheduleFloatingScrollbars, 0));             // tab switches, collapsibles
  scheduleFloatingScrollbars();
}
document.addEventListener('DOMContentLoaded', initFloatingScrollbars);

async function captureFull(el){
  el.classList.add('exporting');
  try{ return await html2canvas(el, {scale:2, backgroundColor:'#ffffff', useCORS:true, allowTaint:true, logging:false}); }
  finally{ el.classList.remove('exporting'); }
}
// opts.autoName: `filename` is the final name (with .png / .pdf) — no "save as" prompt (course reports, reportFileName)
async function exportTableImage(containerId, filename, opts){
  const el = document.getElementById(containerId);
  if(!el){ toast('Nothing to export','err'); return; }
  if(typeof html2canvas === 'undefined'){ toast('Image export library failed to load — check your connection and try again','err'); return; }
  const chosenName = (opts && opts.autoName) ? filename : await promptForFilename(filename, 'png');
  if(!chosenName) return;
  try{
    const canvas = await captureFull(el);
    canvas.toBlob((blob)=>{
      if(!blob){ toast('Image export failed: could not generate image data','err'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = chosenName;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 5000);
      toast('Image downloaded','ok');
    }, 'image/png');
  }catch(e){ console.error('Image export error:', e); toast('Image export failed: ' + (e && e.message ? e.message : 'unknown error'), 'err'); }
}
async function exportTablePDF(containerId, filename, opts){
  const el = document.getElementById(containerId);
  if(!el){ toast('Nothing to export','err'); return; }
  if(typeof html2canvas === 'undefined' || !window.jspdf){ toast('PDF export library failed to load — check your connection and try again','err'); return; }
  const chosenName = (opts && opts.autoName) ? filename : await promptForFilename(filename, 'pdf');
  if(!chosenName) return;
  try{
    const canvas = await captureFull(el);
    const { jsPDF } = window.jspdf;
    const imgW = canvas.width, imgH = canvas.height;
    const pdf = new jsPDF({orientation: imgW>imgH?'l':'p', unit:'px', format:[imgW, imgH]});
    pdf.addImage(canvas, 'PNG', 0, 0, imgW, imgH);
    const pdfBlob = pdf.output('blob');
    const pdfUrl = URL.createObjectURL(pdfBlob);
    const link = document.createElement('a');
    link.download = chosenName;
    link.href = pdfUrl;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(pdfUrl), 5000);
    toast('PDF downloaded','ok');
  }catch(e){ console.error('PDF export error:', e); toast('PDF export failed: ' + (e && e.message ? e.message : 'unknown error'), 'err'); }
}
