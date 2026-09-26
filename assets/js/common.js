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
let ops = {assignments:{}, attendance:{}};
let leaveRequestsCache = [];
async function loadCoreData(){
  // one request for all four (a single round-trip instead of four)
  const r = await getSharedMany([K_MASTER, K_PENDING, K_CONFIG, K_OPS], {
    [K_MASTER]: [],
    [K_PENDING]: [],
    [K_CONFIG]: {dates:[], maxCapacity:30, trainerNames:[], coordinatorNames:[], trainingNames:[]},
    [K_OPS]: {assignments:{}, attendance:{}}
  });
  masterData = r[K_MASTER]; pendingList = r[K_PENDING]; trainingConfig = r[K_CONFIG]; ops = r[K_OPS];
  if(!trainingConfig.dates) trainingConfig.dates = [];
  if(!trainingConfig.trainerNames) trainingConfig.trainerNames = [];
  if(!trainingConfig.coordinatorNames) trainingConfig.coordinatorNames = [];
  if(!trainingConfig.trainingNames) trainingConfig.trainingNames = [];
  if(!trainingConfig.maxCapacity) trainingConfig.maxCapacity = 30;
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
  // Trainer > Setup is stored in the sheet and, if present, replaces it; "Remove Logo" goes back to the file.
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
let supFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), date:new Set() };
let supSearchQ = '';
let trainerFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), date:new Set() };
let trainerSearchQ = '';
let masterFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), date:new Set() };
let masterSearchQ = '';
let daysFilterState = { city:new Set(), type:new Set(), date:new Set(), trainer:new Set(), visibleTo:new Set(), status:new Set() };
let daysSearchQ = '';
let msOptionsCache = {};

function filterStateFor(scope){
  if(scope==='sup') return supFilterState;
  if(scope==='trainer') return trainerFilterState;
  if(scope==='days') return daysFilterState;
  return masterFilterState;
}
function rerenderScope(scope){
  if(scope==='sup') renderSupervisorTable();
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
  const days = (scope==='sup') ? visibleDaysFor(currentSupervisor) : (trainingConfig.dates||[]);
  let html = `<option value="">— Assign selected to… —</option><optgroup label="Training Days">`;
  days.forEach(d=>{
    const passed = (scope==='sup' && isDeadlinePassed(d)) ? ' (Deadline passed)' : '';
    const hidden = d.active===false ? ' (hidden from supervisors)' : '';
    html += `<option value="date:${d.id}">${d.isOnline?'🌐 ':''}${esc(d.city)} — ${dayDateLabel(d)}${passed}${hidden}</option>`;
  });
  html += `</optgroup><optgroup label="Other Status">`;
  LEAVE_STATUSES.forEach(s=>{ html += `<option value="leave:${esc(s)}">${esc(s)}</option>`; });
  html += `</optgroup><option value="__none__">Not Assigned (unassign)</option>`;
  return html;
}
function updateBulkBar(scope){
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
    html += `<button class="btn btn-outline btn-sm" onclick="bulkDays('hide')">🙈 Hide</button>`
          + `<button class="btn btn-outline btn-sm" onclick="bulkDays('unhide')">👁 Unhide</button>`
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

function renderMsFilter(scope, key, label, options){
  msOptionsCache[scope+'_'+key] = options.map(o=>o.value);
  const state = filterStateFor(scope)[key];
  const count = state.size;
  const itemsHtml = options.map(o=>{
    const isChecked = state.has(o.value);
    return `<label class="ms-item${isChecked?' checked':''}" data-text="${esc(o.text.toLowerCase())}"><input type="checkbox" value="${esc(o.value)}" ${isChecked?'checked':''} onchange="onMsToggle('${scope}','${key}',this.value,this.checked);this.closest('.ms-item').classList.toggle('checked',this.checked);"><span>${esc(o.text)}</span></label>`;
  }).join('') || '<span class="small-note">No options</span>';
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

function dateFilterOptions(days){
  return days.map(d=>({value:'date:'+d.id, text: d.city+' — '+dayDateLabel(d)+(d.active===false?' (hidden)':'')}))
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
  if(key==='completionPct'){
    const n = parseFloat(p.completionPct);
    return isNaN(n) ? -1 : n;
  }
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
function assignOptionLabel(d, enforceDeadline){
  const passed = enforceDeadline && isDeadlinePassed(d);
  return `${d.isOnline?'🌐 ':''}${esc(d.city)} — ${dayDateLabel(d)}${passed?' (Deadline passed)':''}${d.active===false?' (hidden from supervisors)':''}`;
}
function assignmentOptionsHtml(pid, days, enforceDeadline){
  const current = ops.assignments[pid];
  let html = `<option value="" ${!current?'selected':''}>-- Not Assigned --</option>`;
  html += `<optgroup label="Training Days">`;
  days.forEach(d=>{
    const val = 'date:'+d.id;
    const sel = current && current.type==='date' && current.dateId===d.id ? 'selected' : '';
    const passed = enforceDeadline && isDeadlinePassed(d);
    html += `<option value="${val}" ${sel} ${passed?'disabled':''}>${assignOptionLabel(d, enforceDeadline)}</option>`;
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
function currentAssignOptionHtml(pid, relevantDays, enforceDeadline){
  const a = ops.assignments[pid];
  if(a && a.type==='date'){
    const d = relevantDays.find(x=>x.id===a.dateId);
    if(d){
      const passed = enforceDeadline && isDeadlinePassed(d);
      return `<option value="date:${d.id}" selected${passed?' disabled':''}>${assignOptionLabel(d, enforceDeadline)}</option>`;
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
  const src = (fn === 'onAssignChange') ? visibleDaysFor(currentSupervisor) : trainingConfig.dates;
  const relevantDays = src.filter(d => !!d.isOnline === online);
  const cur = sel.value;
  sel.innerHTML = assignmentOptionsHtml(pid, relevantDays, enforceDeadline);
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
      badge = `<span class="badge" style="background:var(--pending-bg);color:var(--pending);border:1px solid var(--pending);">⏳ Pending Quota Approval — ${esc(day.city)}</span>`;
    } else {
      badge = `<span class="badge badge-date">${day.isOnline?'🌐 ':''}${esc(day.city)} — ${dayDateLabel(day)}</span>`;
    }
  }
  if(!editable) return badge;
  const enforceDeadline = changeFn==='onAssignChange';
  const relevantDays = days.filter(d => !!d.isOnline === isOnlinePharmacist(p));
  const collapsed = currentAssignOptionHtml(p.id, relevantDays, enforceDeadline);
  return `<div>${badge}<br><select class="assign-select" data-pid="${p.id}" data-fn="${changeFn}" data-online="${isOnlinePharmacist(p)?1:0}" onfocus="fillAssignSelect(this)" onmousedown="fillAssignSelect(this)" onchange="${changeFn}('${p.id}', this.value)">${collapsed}</select></div>`;
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
// Returns {status: 'Attended'|'Absent'|'Partial'|undefined, punctuality, missingDay, day1, day2}
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
    if(s1==='Absent' && s2==='Absent') return {status:'Absent', day1:s1, day2:s2};
    if(!s1 && !s2) return {status: undefined};
    return {status:'Partial', missingDay: s1==='Attended'?2:1, day1:s1, day2:s2};
  }
  return {status: att.status, punctuality: att.punctuality};
}
// Fully attended (both days, for a split online training). Once true, supervisors can no longer change the
// pharmacist's assignment — only the training team can (enforced on the server too).
function hasAttendedTraining(p){
  return attSummary(p.id, p).status==='Attended';
}
// Attendance as the supervisor sees it in their Pharmacist List.
function attendanceBadgeHtml(p){
  const a = ops.assignments[p.id];
  if(!a || a.type!=='date' || !dayById(a.dateId)) return '<span class="small-note">—</span>';
  if(a.overQuota && !a.quotaApproved) return '<span class="small-note">—</span>';
  const s = attSummary(p.id, p);
  if(s.status==='Attended') return `<span class="badge badge-att-ok">✔ Attended — ${esc(s.punctuality||'On Time')}</span>`;
  if(s.status==='Absent') return `<span class="badge badge-danger">✕ Absent</span>`;
  if(s.status==='Partial') return `<span class="badge badge-leave">Partial — Day ${s.missingDay} missing</span>`;
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
function completionCellHtml(p){
  if(p.completionPct===undefined || p.completionPct===''){ return '<span class="small-note">—</span>'; }
  const n = parseFloat(p.completionPct);
  if(isNaN(n)) return esc(p.completionPct);
  const clamped = Math.max(0, Math.min(100, n));
  const color = n>=100 ? 'var(--navy)' : 'var(--blue)';
  return `<div class="compl-cell">
      <div class="compl-bar-track"><div class="compl-bar-fill" style="width:${clamped}%;background:${color};"></div></div>
      <span class="compl-pct-text" style="color:${color};">${n}%</span>
    </div>`;
}
function attendanceStatusText(p){
  const s = attSummary(p.id, p);
  if(!s.status) return 'Not Assigned';
  if(s.status==='Attended'){
    if(isSplitPerson(p)) return 'Attended (both days) - ' + s.punctuality;
    const att = ops.attendance[p.id];
    return 'Attended - ' + s.punctuality + (s.punctuality==='Late' && att.time ? ' ('+att.time+')' : '');
  }
  if(s.status==='Partial'){
    return `Partial — Day ${s.missingDay} missing (make-up needed)`;
  }
  return s.status;
}

// Two training days can share a city and date (e.g. online "Mix 3" and "Mix 4" both starting 5 Oct), which makes their
// "City — date" text identical. Only in that case the training name is added, so the Date text — in the tables, the
// exports, and an Excel re-upload — points at exactly one day.
let _dupDayCount = null, _dupDaySrc = null, _dupDayLen = -1;
function dayDisambiguator(day){
  const arr = trainingConfig.dates || [];
  if(_dupDaySrc!==arr || _dupDayLen!==arr.length){
    _dupDayCount = {};
    arr.forEach(d=>{ const k = d.city+'|'+dayDateLabel(d); _dupDayCount[k] = (_dupDayCount[k]||0)+1; });
    _dupDaySrc = arr; _dupDayLen = arr.length;
  }
  return (_dupDayCount[day.city+'|'+dayDateLabel(day)]>1 && day.trainingName) ? ` (${day.trainingName})` : '';
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
    completionPct: p.completionPct!==undefined && p.completionPct!=='' ? p.completionPct+'%' : '',
    statusText,
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
<fills count="8">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF003261"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF0F5FB"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC6E0B4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF4CCCC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFDCE4EF"/></left><right style="thin"><color rgb="FFDCE4EF"/></right><top style="thin"><color rgb="FFDCE4EF"/></top><bottom style="thin"><color rgb="FFDCE4EF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
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
function buildSheetXml_(headers, rows, colWidths, opts){
  opts = opts || {};
  const statusColIndex = opts.statusColIndex!==undefined ? opts.statusColIndex : -1;
  const autoFilter = !!opts.autoFilter;
  const numCols = headers.length;
  const numRows = rows.length + 1;
  const lastCol = xlsxColLetter_(numCols-1);
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${numRows}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
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
      if(ci===statusColIndex){
        const override = statusCellStyle_(val);
        if(override!==null) styleIdx = override;
      }
      return `<c r="${xlsxColLetter_(ci)}${r}" s="${styleIdx}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc_(val)}</t></is></c>`;
    }).join('') + `</row>`;
  });
  xml += `</sheetData>`;
  if(autoFilter) xml += `<autoFilter ref="A1:${lastCol}1"/>`;
  xml += `</worksheet>`;
  return xml;
}
async function downloadStyledXlsx(filename, sheetName, headers, rows, colWidths, opts){
  if(typeof JSZip === 'undefined'){
    toast('Excel export library failed to load — check your connection and try again','err');
    return false;
  }
  const baseName = filename.replace(/\.xlsx$/i, '');
  const chosenName = await promptForFilename(baseName, 'xlsx');
  if(!chosenName) return false;
  filename = chosenName;
  try{
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc_(sheetName).slice(0,31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file('xl/styles.xml', buildStylesXml_());
    zip.file('xl/worksheets/sheet1.xml', buildSheetXml_(headers, rows, colWidths, opts));
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

/* ═══════════════════════════════ MODAL ═══════════════════════════════ */
function showModal(html, boxStyle){
  document.getElementById('modalRoot').innerHTML = `<div class="modal-overlay"><div class="modal-box" style="${boxStyle||''}">${html}</div></div>`;
}
function closeModal(){ document.getElementById('modalRoot').innerHTML=''; }

/* ═══════════════════════════════ EXPORTS (IMAGE / PDF) ═══════════════════════════════ */
async function exportTableImage(containerId, filename){
  const el = document.getElementById(containerId);
  if(!el){ toast('Nothing to export','err'); return; }
  if(typeof html2canvas === 'undefined'){ toast('Image export library failed to load — check your connection and try again','err'); return; }
  const chosenName = await promptForFilename(filename, 'png');
  if(!chosenName) return;
  try{
    const canvas = await html2canvas(el, {scale:2, backgroundColor:'#ffffff', useCORS:true, allowTaint:true, logging:false});
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
async function exportTablePDF(containerId, filename){
  const el = document.getElementById(containerId);
  if(!el){ toast('Nothing to export','err'); return; }
  if(typeof html2canvas === 'undefined' || !window.jspdf){ toast('PDF export library failed to load — check your connection and try again','err'); return; }
  const chosenName = await promptForFilename(filename, 'pdf');
  if(!chosenName) return;
  try{
    const canvas = await html2canvas(el, {scale:2, backgroundColor:'#ffffff', useCORS:true, allowTaint:true, logging:false});
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
