/* Trainer page logic (setup, attendance, approvals, analytics, calendar). */
let calendarBaseYear, calendarBaseMonth;
let dragDayId = null;

/* Undo/Redo for training-config changes (days, trainer roster, training names, capacity) */
let configUndoStack = [];
let configRedoStack = [];
const MAX_CONFIG_HISTORY = 30;
async function setConfigWithHistory(newConfig){
  // "before" is the state this page last read — NOT a fresh read, so the save below only sends this page's own changes
  const before = peekSnapshot(K_CONFIG) || await getShared(K_CONFIG, newConfig);
  const ok = await setShared(K_CONFIG, newConfig);
  if(ok){
    configUndoStack.push(JSON.stringify(before));
    if(configUndoStack.length>MAX_CONFIG_HISTORY) configUndoStack.shift();
    configRedoStack = [];
    updateUndoRedoButtons();
  }
  return ok;
}
function updateUndoRedoButtons(){
  const u = document.getElementById('calUndoBtn');
  const r = document.getElementById('calRedoBtn');
  if(u) u.disabled = configUndoStack.length===0;
  if(r) r.disabled = configRedoStack.length===0;
}
async function undoCalendarChange(){
  if(!configUndoStack.length) return;
  const prev = JSON.parse(configUndoStack.pop());
  const current = await getShared(K_CONFIG, trainingConfig);
  configRedoStack.push(JSON.stringify(current));
  trainingConfig = prev;
  const ok = await setShared(K_CONFIG, trainingConfig);
  updateUndoRedoButtons();
  if(ok){ toast('Undone','ok'); renderCalendar(); buildDaysFilterBar(); renderDaysTable(); renderTrainerNamesList(); renderCoordinatorNamesList(); renderTrainingNamesList(); buildTrainerFilterBar(); }
}
async function redoCalendarChange(){
  if(!configRedoStack.length) return;
  const next = JSON.parse(configRedoStack.pop());
  const current = await getShared(K_CONFIG, trainingConfig);
  configUndoStack.push(JSON.stringify(current));
  trainingConfig = next;
  const ok = await setShared(K_CONFIG, trainingConfig);
  updateUndoRedoButtons();
  if(ok){ toast('Redone','ok'); renderCalendar(); buildDaysFilterBar(); renderDaysTable(); renderTrainerNamesList(); renderCoordinatorNamesList(); renderTrainingNamesList(); buildTrainerFilterBar(); }
}

async function handleCalendarDrop(e, iso){
  e.preventDefault();
  e.stopPropagation();
  if(!dragDayId) return;
  const dayId = dragDayId;
  dragDayId = null;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  const day = trainingConfig.dates.find(d=>d.id===dayId);
  if(!day) return;
  if(day.date === iso) return;
  if(day.isOnline && day.onlineFormat==='split' && new Date(iso+'T00:00:00').getDay()===5){
    toast('Split online trainings cannot be scheduled on a Friday — please choose a different date','err');
    return;
  }
  day.date = iso;
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    toast(`Moved to ${formatDate(iso)}`, 'ok');
    renderCalendar();
    buildDaysFilterBar();
    renderDaysTable();
    buildTrainerFilterBar();
  }
}

async function exportCalendarExcel(){
  if(!trainingConfig.dates.length){ toast('No training days to export','err'); return; }
  const headers = ['Date','City','Training Name','Type','Trainer(s)','Visible To','Assigned','Capacity','Deadline','Online','Format','Coordinator','Zoom Link','Venue'];
  const rows = [];
  [...trainingConfig.dates].sort((a,b)=>a.date.localeCompare(b.date)).forEach(d=>{
    rows.push([
      dayDateLabel(d), d.city, d.trainingName||'', d.type||'Pharmacist Training',
      (d.trainerNames||[]).join(', '), (d.visibleSupervisors||[]).join(', '),
      dayCount(d.id), dayCapacity(d), d.deadline?formatDateTime(d.deadline):'',
      d.isOnline?'Yes':'No', d.isOnline?(d.onlineFormat==='fullday'?'Full day':'Split (2 days)'):'',
      d.coordinator||'', d.zoomLink||'', d.venue||''
    ]);
  });
  const colWidths = [14,14,20,16,20,26,10,10,18,8,14,16,24,26];
  const ok = await downloadStyledXlsx('training-calendar.xlsx', 'Calendar', headers, rows, colWidths);
  if(ok) toast('Calendar downloaded','ok');
}

function shiftCalendarQuarter(delta){
  calendarBaseMonth += delta*3;
  while(calendarBaseMonth<0){ calendarBaseMonth+=12; calendarBaseYear--; }
  while(calendarBaseMonth>11){ calendarBaseMonth-=12; calendarBaseYear++; }
  renderCalendar();
}
function scrollToCalMonth(i){
  const el = document.getElementById('cal-month-'+i);
  if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
}

/* Sequential per-city instance numbers for calendar labels, e.g. ABH 1, ABH 2, ABH 3 — in date order */
function computeCityInstanceNumbers(){
  const byCity = {};
  const nonOnline = trainingConfig.dates.filter(d=>!d.isOnline).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const numbers = {};
  nonOnline.forEach(d=>{
    const code = cityColorFor(d).code;
    byCity[code] = (byCity[code]||0) + 1;
    numbers[d.id] = byCity[code];
  });
  return numbers;
}

async function renderCalendar(){
  await loadCoreData();
  updateUndoRedoButtons();
  const now = new Date();
  if(calendarBaseYear===undefined){ calendarBaseYear = now.getFullYear(); calendarBaseMonth = now.getMonth(); }
  const endMonth = calendarBaseMonth+2;
  const endYear = calendarBaseYear + Math.floor(endMonth/12);
  document.getElementById('calendarQuarterLabel').textContent = `${MONTHS[calendarBaseMonth]} ${calendarBaseYear} – ${MONTHS[endMonth%12]} ${endYear}`;

  const usedCities = [...new Map(trainingConfig.dates.filter(d=>!d.isOnline).map(d=>{
    const c = cityColorFor(d);
    return [c.code, c];
  })).values()];
  const hasOnline = trainingConfig.dates.some(d=>d.isOnline);
  const legendItems = usedCities.concat(hasOnline?[ONLINE_COLOR]:[]);
  document.getElementById('calendarLegend').innerHTML = legendItems.length
    ? legendItems.map(c=>`<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${c.bg};border:1px solid ${c.border};"></span>${esc(c.code)}</span>`).join('')
    : `<span class="small-note">No training days scheduled yet — add one from Setup to see it here.</span>`;

  const instanceNumbers = computeCityInstanceNumbers();
  const monthLinks = [];
  let monthsHtml = '';
  for(let i=0;i<3;i++){
    const mIdx = (calendarBaseMonth+i) % 12;
    const yr = calendarBaseYear + Math.floor((calendarBaseMonth+i)/12);
    monthLinks.push(`<button type="button" class="btn btn-outline btn-sm" onclick="scrollToCalMonth(${i})">${MONTHS[mIdx]} ${yr}</button>`);
    monthsHtml += renderCalendarMonth(yr, mIdx, i, instanceNumbers);
  }
  document.getElementById('calendarMonthLinks').innerHTML = monthLinks.join('');
  document.getElementById('calendarMonthsContainer').innerHTML = monthsHtml;

  renderCalendarAnalytics();
}

function renderCalendarMonth(year, month, sectionIdx, instanceNumbers){
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for(let i=0;i<startOffset;i++){
    cells.push({day: daysInPrevMonth-startOffset+1+i, other:true});
  }
  for(let d=1; d<=daysInMonth; d++){
    cells.push({day:d, other:false});
  }
  while(cells.length % 7 !== 0){
    cells.push({day: cells.length - startOffset - daysInMonth + 1, other:true});
  }

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = `<div class="card" id="cal-month-${sectionIdx}" style="margin-top:14px;">
    <h3 style="margin:0 0 10px;font-size:14px;color:var(--navy);">${MONTHS[month]} ${year}</h3>
    <div class="cal-grid">` + dayNames.map(n=>`<div class="cal-head">${n}</div>`).join('');
  cells.forEach(cell=>{
    if(cell.other){
      html += `<div class="cal-cell other-month"><div class="cal-daynum">${cell.day}</div></div>`;
      return;
    }
    const iso = `${year}-${String(month+1).padStart(2,'0')}-${String(cell.day).padStart(2,'0')}`;
    const dayEvents = trainingConfig.dates.filter(d=>{
      if(d.date===iso) return true;
      if(d.isOnline && d.onlineFormat==='split'){
        return addOneDayIso(d.date)===iso;
      }
      return false;
    });
    const eventsHtml = dayEvents.map(d=>{
      const isContinuation = d.date!==iso;
      const c = cityColorFor(d);
      const count = dayCount(d.id);
      const num = instanceNumbers[d.id];
      const isActive = d.active!==false;
      const label = d.isOnline ? (d.trainingName || c.code) : ((num ? `${c.code} ${num}` : c.code));
      const trainerLine = (d.trainerNames && d.trainerNames.length) ? `<br><span style="font-weight:400;">${esc(d.trainerNames.join(', '))}</span>` : '';
      const dayTag = isContinuation ? '<br><span style="font-weight:400;font-size:8.5px;opacity:.8;">· Day 2</span>' : '';
      const dragAttrs = isContinuation ? '' : `draggable="true" ondragstart="event.stopPropagation(); dragDayId='${d.id}'; event.dataTransfer.effectAllowed='move'; this.classList.add('cal-event-dragging');" ondragend="dragDayId=null; this.classList.remove('cal-event-dragging'); document.querySelectorAll('.cal-cell-dragover').forEach(el=>el.classList.remove('cal-cell-dragover'));"`;
      return `<span class="cal-event" ${dragAttrs} style="background:${c.bg};color:${c.text};border:1px solid ${c.border};${isActive?'':'opacity:.5;'}${isContinuation?'opacity:.85;':''}" onclick="event.stopPropagation(); openEditDayModal('${d.id}')" title="${esc(d.city)}${d.trainingName?' — '+esc(d.trainingName):''} — ${count}/${dayCapacity(d)}${isActive?'':' — Hidden from supervisors'}${isContinuation?' — Day 2 of split online training':''}">${esc(label)}${!isActive?' 🙈':''}${trainerLine}${dayTag}</span>`;
    }).join('');
    html += `<div class="cal-cell" onclick="openAddDayModal('${iso}')" ondragover="event.preventDefault();" ondragenter="event.preventDefault(); this.classList.add('cal-cell-dragover');" ondragleave="this.classList.remove('cal-cell-dragover');" ondrop="this.classList.remove('cal-cell-dragover'); handleCalendarDrop(event, '${iso}')"><div class="cal-daynum">${cell.day}</div>${eventsHtml}</div>`;
  });
  html += `</div></div>`;
  return html;
}

function renderCalendarAnalytics(){
  const trainerCounts = {};
  trainingConfig.trainerNames.forEach(n=>{ trainerCounts[n]=0; });
  trainingConfig.dates.forEach(d=>{
    (d.trainerNames||[]).forEach(n=>{ trainerCounts[n] = (trainerCounts[n]||0)+1; });
  });
  const tBody = document.getElementById('calAnalyticsTrainerBody');
  const tKeys = Object.keys(trainerCounts).sort((a,b)=>a.localeCompare(b));
  tBody.innerHTML = tKeys.length
    ? tKeys.map(n=>`<tr><td>${trainerBadge(n)}</td><td>${trainerCounts[n]}</td></tr>`).join('')
    : `<tr><td colspan="2" class="empty-msg">No trainers in the roster yet</td></tr>`;

  function isoWeekStart(dateStr){
    const d = new Date(dateStr+'T00:00:00');
    const day = d.getDay();
    const diff = (day===0?-6:1) - day;
    d.setDate(d.getDate()+diff);
    return d.toISOString().slice(0,10);
  }
  const weeks = {};
  trainingConfig.dates.forEach(d=>{
    const wk = isoWeekStart(d.date);
    if(!weeks[wk]) weeks[wk] = {};
    (d.trainerNames||[]).forEach(n=>{ weeks[wk][n] = (weeks[wk][n]||0)+1; });
  });
  const weekKeys = Object.keys(weeks).sort();
  const wHead = document.getElementById('calAnalyticsWeekHead');
  wHead.innerHTML = `<th>Week Of</th>` + tKeys.map(n=>`<th>${esc(n)}</th>`).join('');
  const wBody = document.getElementById('calAnalyticsWeekBody');
  wBody.innerHTML = weekKeys.length
    ? weekKeys.map(wk=>`<tr><td>${formatDate(wk)}</td>${tKeys.map(n=>`<td>${weeks[wk][n]||0}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${tKeys.length+1}" class="empty-msg">No training days yet</td></tr>`;

  const regionMap = {};
  trainingConfig.dates.filter(d=>!d.isOnline).forEach(d=>{
    const code = cityColorFor(d).code;
    if(!regionMap[code]) regionMap[code] = {days:0, assignedTotal:0};
    regionMap[code].days++;
    regionMap[code].assignedTotal += dayCount(d.id);
  });
  masterData.forEach(p=>{
    const code = cityColorFor({city:p.city, isOnline:false}).code;
    if(!regionMap[code]) regionMap[code] = {days:0, assignedTotal:0};
    regionMap[code].pharmacists = (regionMap[code].pharmacists||0) + 1;
  });
  const rKeys = Object.keys(regionMap).sort();
  const rBody = document.getElementById('calAnalyticsRegionBody');
  rBody.innerHTML = rKeys.length
    ? rKeys.map(code=>{
        const r = regionMap[code];
        const avg = r.days ? Math.round((r.assignedTotal/r.days)*10)/10 : 0;
        return `<tr><td>${esc(code)}</td><td>${r.pharmacists||0}</td><td>${r.days||0}</td><td>${avg}</td></tr>`;
      }).join('')
    : `<tr><td colspan="4" class="empty-msg">No data yet</td></tr>`;
}

/* ═══════════════════════════════ CALENDAR EXCEL IMPORT ═══════════════════════════════ */
const CAL_CODE_PATTERNS = [
  {re:/^JED\s*N/i, city:'Jeddah North'}, {re:/^JED\s*S/i, city:'Jeddah South'}, {re:/^JED/i, city:'Jeddah'},
  {re:/^RUH/i, city:'Riyadh'}, {re:/^MEC/i, city:'Mecca'}, {re:/^MAD/i, city:'Madinah'},
  {re:/^EAST/i, city:'Eastern'}, {re:/^TAIF/i, city:'Taif'}, {re:/^ABH/i, city:'Abha'},
  {re:/^BAHAH/i, city:'Al Bahah'}, {re:/^JAZ/i, city:'Jazan'}
];
function openCalendarImportModal(){
  showModal(`
    <h3>Calendar sync</h3>
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;background:#f7faff;">
      <p class="small-note" style="margin:0 0 8px;"><b>Automatic.</b> The "2026 - Q4 Training Calendar" tab of your Google Sheet is read by the server whenever the app loads (at most once a minute). New trainings appear for supervisors on their own; a training that moves keeps its assigned pharmacists; one removed from the sheet is hidden, never deleted. Anything you set here (visible-to, quotas, capacity, deadline, venue) is kept.</p>
      <button class="btn btn-navy btn-sm" onclick="syncCalendarNow()">↻ Sync now</button>
    </div>
    <details style="margin-bottom:10px;">
      <summary class="small-note" style="cursor:pointer;">Advanced: import from an Excel file instead</summary>
      <p class="small-note" style="margin-top:8px;">Weekly grid layout: a row of weekday dates ("Tue 8 Sep"), a row of city/training codes beneath, and a row of trainer names beneath that. "MIX" codes become online trainings. Unrecognized codes (holidays, "Salaries"…) are skipped.</p>
      <div class="field"><input type="file" id="calImportFile" accept=".xlsx,.xls"></div>
      <button class="btn btn-outline btn-sm" onclick="confirmCalendarImport()">Import File</button>
    </details>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Close</button>
    </div>`, 'max-width:600px;');
}

/* Ask the server to re-read the calendar tab right now (it also does this by itself). */
async function syncCalendarNow(){
  closeModal();
  toast('Reading the calendar tab…','info');
  try{
    const s = (await API.syncCalendar()) || {};
    await renderCalendar();
    buildDaysFilterBar(); renderDaysTable(); buildTrainerFilterBar(); renderTrainerNamesList();
    const li = t => `<li style="margin:5px 0;">${t}</li>`;
    let items = '';
    if(s.added) items += li(`<b>${s.added}</b> new training day(s) added.`);
    if(s.updated) items += li(`<b>${s.updated}</b> training day(s) updated from the calendar (dates / trainers).`);
    if(s.reactivated) items += li(`${s.reactivated} training day(s) that came back into the calendar were re-opened.`);
    if(s.deactivated) items += li(`<b>${s.deactivated}</b> training day(s) are no longer in the calendar and were hidden from supervisors (their assignments are kept).`);
    if(s.trainersAdded && s.trainersAdded.length) items += li(`Added to your trainer roster: <b>${esc(s.trainersAdded.join(', '))}</b>.`);
    if(s.unmatched && s.unmatched.length) items += li(`No supervisor found yet for: <b>${esc(s.unmatched.join(', '))}</b> — set "Visible to" on those days, or add that city's pharmacists to HeadCount.`);
    if(s.skipped && s.skipped.length) items += li(`Not trainings, so not imported: ${esc(s.skipped.join(', '))}.`);
    if(!items) items = li('Everything was already up to date.');
    showModal(`<h3>Calendar synced</h3><ul style="padding-left:18px;font-size:13px;line-height:1.55;">${items}</ul>
      <div class="modal-actions"><button class="btn btn-navy btn-sm" onclick="closeModal()">OK</button></div>`, 'max-width:560px;');
  }catch(err){
    console.error(err);
    toast('Could not sync the calendar: '+(err.message||''), 'err');
  }
}
async function confirmCalendarImport(){
  const file = document.getElementById('calImportFile').files[0];
  if(!file){ toast('Choose a file first','err'); return; }
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:false});
      await importCalendarFromAoa(aoa);
    }catch(err){
      console.error(err);
      toast('Error reading calendar file: '+(err.message||''), 'err');
      closeModal();
    }
  };
  reader.readAsArrayBuffer(file);
}
/* Reads a calendar grid (array of rows) and returns the training days found in it.
   Pure function — no saving — so it can be tested on its own. */
function parseCalendarAoa(aoa){
  let sheetYear = new Date().getFullYear();
  for(const row of aoa.slice(0,3)){
    for(const cell of row){
      const m = String(cell||'').match(/(20\d{2})/);
      if(m){ sheetYear = parseInt(m[1]); break; }
    }
  }

  // "Mon 21 Sep" — some cells are typed without the space ("Mon14 Dec"), so the space is optional
  const dateHeaderRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*(\d{1,2})\s+([A-Za-z]+)/i;
  const monthAbbrs = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  let lastMonthSeen = -1, yearForMonth = sheetYear;

  const importedDays = [];
  const skippedNames = new Set();
  // A widest day block in the grid is 5 columns. Anything further right (the trainer / headcount
  // summary tables next to the calendar) must not be read as training days.
  const MAX_DAY_COLS = 5;

  for(let r=0; r<aoa.length; r++){
    const row = aoa[r];
    const anchors = [];
    for(let c=0; c<row.length; c++){
      const val = String(row[c]||'').trim();
      const m = val.match(dateHeaderRe);
      if(m){
        const monIdx = monthAbbrs[m[3].slice(0,3).toLowerCase()];
        if(monIdx===undefined) continue;
        if(lastMonthSeen!==-1 && monIdx < lastMonthSeen - 6){ yearForMonth++; }
        lastMonthSeen = monIdx;
        anchors.push({col:c, date: `${yearForMonth}-${String(monIdx+1).padStart(2,'0')}-${String(parseInt(m[2])).padStart(2,'0')}`});
      }
    }
    if(!anchors.length) continue;
    const codeRow = aoa[r+1] || [];
    const trainerRow = aoa[r+2] || [];
    anchors.forEach((anchor, ai)=>{
      const nextCol = ai+1 < anchors.length ? Math.min(anchors[ai+1].col, anchor.col+MAX_DAY_COLS) : (anchor.col + MAX_DAY_COLS);
      for(let c=anchor.col; c<nextCol; c++){
        const code = String(codeRow[c]||'').trim();
        if(!code) continue;
        const trainerRaw = String(trainerRow[c]||'').trim();
        const looksLikeCode = /\d/.test(trainerRaw) || CAL_CODE_PATTERNS.some(p=>p.re.test(trainerRaw)) || /^mix/i.test(trainerRaw);
        const trainer = (trainerRaw && !looksLikeCode && trainerRaw.toLowerCase()!=='eg' && trainerRaw.toLowerCase()!=='co') ? trainerRaw : '';
        if(/^mix/i.test(code)){
          const numMatch = code.match(/\d+/);
          const mixLabel = numMatch ? `Mix ${numMatch[0]}` : 'Mix';
          importedDays.push({code:code.toUpperCase().replace(/\s+/g,''), date:anchor.date, city:'Online', trainingName:mixLabel, isOnline:true, onlineFormat:'split', trainer});
          continue;
        }
        const cityMatch = CAL_CODE_PATTERNS.find(p=>p.re.test(code));
        if(!cityMatch){
          if(!dateHeaderRe.test(code)) skippedNames.add(code);   // a week with no codes: the "code" row is the next week's date row
          continue;
        }
        importedDays.push({code:code.toUpperCase().replace(/\s+/g,''), date:anchor.date, city:cityMatch.city, trainingName:'', isOnline:false, trainer});
      }
    });
  }
  // An online "Mix n" training runs over two days and the grid lists it under BOTH dates.
  // In the app it is one training day (day 1; day 2 is implied), so the repeat is dropped.
  const dayMs = iso => Date.parse(iso+'T00:00:00Z');
  const lastMixDay = {};
  const days = importedDays.filter(d=>{
    if(!d.isOnline) return true;
    const prev = lastMixDay[d.trainingName];
    const gap = prev===undefined ? null : (dayMs(d.date)-prev)/86400000;
    if(gap!==null && gap>0 && gap<=3) return false;
    lastMixDay[d.trainingName] = dayMs(d.date);
    return true;
  });
  // identity of each entry = its code (same rule as the server's calendar sync); repeats are numbered
  const codeCount = {};
  days.forEach(d=>{ codeCount[d.code] = (codeCount[d.code]||0)+1; if(codeCount[d.code]>1) d.code += '#'+codeCount[d.code]; });
  return {importedDays:days, skippedNames:[...skippedNames]};
}

async function importCalendarFromAoa(aoa){
  {
    {
      const parsed = parseCalendarAoa(aoa);
      const importedDays = parsed.importedDays;
      const skipped = parsed.skippedNames.length;

      if(!importedDays.length){
        toast('No recognizable training days found in this file','err');
        closeModal();
        return;
      }

      masterData = await getShared(K_MASTER, []);
      trainingConfig = await getShared(K_CONFIG, trainingConfig);

      // Running the import twice must not double the calendar: days that already exist
      // (same date + city, or same date + Mix number) are left alone.
      const knownCodes = new Set(trainingConfig.dates.filter(d=>d.calendarCode).map(d=>d.calendarCode));
      const keyOf = d => [d.date, d.isOnline ? 'online' : d.city, d.trainingName||''].join('|');
      const existing = {};
      trainingConfig.dates.filter(d=>!d.calendarCode).forEach(d=>{ const k = keyOf(d); existing[k] = (existing[k]||0)+1; });

      let autoAssignedCount = 0, addedCount = 0, alreadyThere = 0;
      const unmatchedCities = new Set(), newTrainers = new Set();
      importedDays.forEach(item=>{
        if(knownCodes.has(item.code)){ alreadyThere++; return; }          // already synced from the calendar tab
        const k = keyOf({date:item.date, city:item.city, isOnline:item.isOnline, trainingName:item.trainingName});
        if(existing[k] > 0){ existing[k]--; alreadyThere++; return; }      // added by hand earlier

        // trainer names written in the calendar are added to the roster if they are new
        let matchedTrainer = '';
        if(item.trainer){
          matchedTrainer = trainingConfig.trainerNames.find(n=>n.toLowerCase()===item.trainer.toLowerCase()) || '';
          if(!matchedTrainer){
            matchedTrainer = item.trainer;
            trainingConfig.trainerNames.push(matchedTrainer);
            newTrainers.add(matchedTrainer);
          }
        }
        let visibleSupervisors = [];
        if(item.isOnline){
          // Mix (online) days have no city — offer them to the supervisors who have Online pharmacists
          visibleSupervisors = [...new Set(masterData.filter(isOnlinePharmacist).map(p=>p.supervisor).filter(isValidSupervisorName))];
          if(visibleSupervisors.length) autoAssignedCount++;
        } else {
          const itemCode = cityColorFor({city:item.city, isOnline:false}).code;
          visibleSupervisors = [...new Set(masterData.filter(p=>cityColorFor({city:p.city, isOnline:false}).code===itemCode).map(p=>p.supervisor).filter(isValidSupervisorName))];
          if(visibleSupervisors.length) autoAssignedCount++;
          else unmatchedCities.add(item.city);
        }
        trainingConfig.dates.push({
          id: uid('day'), date:item.date, city:item.city, trainingName:item.trainingName||'', type:'Pharmacist Training',
          trainerNames: matchedTrainer ? [matchedTrainer] : [], isOnline:item.isOnline, onlineFormat:item.onlineFormat||'',
          coordinator:'', zoomLink:'', visibleSupervisors, active:true,
          calendarCode:item.code, calendarTrainer:matchedTrainer
        });
        addedCount++;
      });
      if(!addedCount){
        closeModal();
        toast(`Nothing new to import — all ${alreadyThere} training day(s) in the calendar are already in the app`, 'info');
        return;
      }
      const ok = await setConfigWithHistory(trainingConfig);
      closeModal();
      if(ok){
        const li = t => `<li style="margin:5px 0;">${t}</li>`;
        let items = li(`<b>${addedCount}</b> training day(s) imported, supervisors matched automatically for <b>${autoAssignedCount}</b> of them.`);
        if(alreadyThere) items += li(`${alreadyThere} day(s) were already in the app and were left as they are.`);
        if(newTrainers.size) items += li(`Added to your trainer roster: <b>${esc([...newTrainers].join(', '))}</b>.`);
        if(unmatchedCities.size) items += li(`No supervisor found yet for: <b>${esc([...unmatchedCities].join(', '))}</b> — those days appear once that city's pharmacists are in the roster, or you can set "Visible to" on each day.`);
        if(skipped) items += li(`Not imported (not pharmacist trainings): ${esc(parsed.skippedNames.join(', '))}.`);
        showModal(`<h3>Calendar imported</h3><ul style="padding-left:18px;font-size:13px;line-height:1.55;">${items}</ul>
          <div class="modal-actions"><button class="btn btn-navy btn-sm" onclick="closeModal()">OK</button></div>`, 'max-width:560px;');
        renderCalendar();
        buildDaysFilterBar();
        renderDaysTable();
        buildTrainerFilterBar();
        renderTrainerNamesList();
      }
    }
  }
}

const MASTER_FIELDS = [
  {key:'district', label:'District', required:false},
  {key:'areaManager', label:'Area Manager', required:false},
  {key:'city', label:'City', required:false},
  {key:'supervisor', label:'Supervisor Name', required:true},
  {key:'pharmacyNo', label:'Pharmacy No.', required:false},
  {key:'employeeId', label:'User/Employee ID', required:false},
  {key:'email', label:'Username (Email)', required:false},
  {key:'displayName', label:'Display Name (Pharmacist Name)', required:true},
  {key:'phone', label:'Phone (Whatsapp)', required:false},
  {key:'scfhs', label:'SCFHS', required:false},
  {key:'note', label:'Notes (shown to the supervisor)', required:false}
];

function showColumnMappingModal(headerRow, autoIndices, totalRows){
  return new Promise(resolve=>{
    const options = (selectedIdx) => `<option value="-1" ${selectedIdx===-1?'selected':''}>-- Not used --</option>` +
      headerRow.map((h,i)=>`<option value="${i}" ${selectedIdx===i?'selected':''}>${esc(h||'(blank header, column '+(i+1)+')')}</option>`).join('');
    const rows = MASTER_FIELDS.map(f=>`
      <tr>
        <td>${esc(f.label)}${f.required?' <span style="color:var(--danger)">*</span>':''}</td>
        <td><select id="map-${f.key}" style="min-width:220px;">${options(autoIndices[f.key])}</select></td>
      </tr>`).join('');
    showModal(`
      <h3>Confirm Column Mapping</h3>
      <p class="small-note">Reviewing <b>${totalRows}</b> data row(s). Each field was auto-matched where possible — if one shows "-- Not used --" or looks wrong, pick the correct column yourself from the dropdown.</p>
      <div class="table-wrap" style="margin:10px 0;"><table style="font-size:11.5px;">
        <thead><tr><th>Field</th><th>Column in your file</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="modal-actions">
        <button class="btn btn-outline btn-sm" id="up-cancel">Cancel</button>
        <button class="btn btn-navy btn-sm" id="up-ok">Confirm &amp; Import</button>
      </div>`);
    document.getElementById('up-ok').onclick = ()=>{
      const result = {};
      MASTER_FIELDS.forEach(f=>{ result[f.key] = parseInt(document.getElementById('map-'+f.key).value); });
      if(result.supervisor===-1 || result.displayName===-1){
        toast('Supervisor Name and Display Name are required — please map both columns','err');
        return;
      }
      closeModal();
      resolve(result);
    };
    document.getElementById('up-cancel').onclick = ()=>{ closeModal(); resolve(null); };
  });
}

let currentTrainerIdentity = '';

/* ═══════════════════════════════ LOGO ═══════════════════════════════ */
// Google Sheets cells hold ~50,000 characters, so the logo is shrunk before it is stored.
function shrinkLogo(dataUrl, maxSide, quality){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=>{
      const scale = Math.min(1, maxSide/Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width*scale));
      c.height = Math.max(1, Math.round(img.height*scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      // keep transparency when the source allows it; fall back to JPEG if PNG is still too big
      let out = c.toDataURL('image/png');
      if(out.length > 40000) out = c.toDataURL('image/jpeg', quality);
      resolve(out);
    };
    img.onerror = ()=>reject(new Error('Could not read that image'));
    img.src = dataUrl;
  });
}
function handleLogoUpload(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      let data = await shrinkLogo(e.target.result, 220, 0.8);
      if(data.length > 45000) data = await shrinkLogo(e.target.result, 140, 0.6);
      if(data.length > 45000){ toast('That logo is too detailed to store — try a simpler image','err'); input.value=''; return; }
      const ok = await setShared(K_LOGO, data);
      if(ok){ toast('Logo updated','ok'); loadLogo(); }
    }catch(err){ toast(err.message||'Could not use that image','err'); }
    input.value = '';
  };
  reader.readAsDataURL(file);
}
async function clearLogo(){
  await setShared(K_LOGO, null);
  loadLogo();
  toast('Logo removed','ok');
}

/* ═══════════════════════════════ SETUP TAB ═══════════════════════════════ */
function switchTrainerTab(id){
  document.querySelectorAll('#screen-trainer .tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===id));
  document.querySelectorAll('.trainer-tab').forEach(t=>t.classList.toggle('hidden', t.id!==id));
  if(id==='t-setup') renderSetupTab();
  if(id==='t-approvals') renderApprovalsTab();
  if(id==='t-analytics') refreshAnalytics();
  if(id==='t-calendar') renderCalendar();
}

async function initTrainer(){
  await Promise.all([loadCoreData(), loadVenues()]);
  renderSetupTab();
  buildTrainerFilterBar();
  renderTrainerTable();
  updatePendingDot();
}

function renderTrainerIdentitySelect(){
  const sel = document.getElementById('trainerIdentitySelect');
  if(!sel) return;
  sel.innerHTML = `<option value="">-- Select your name --</option>` +
    trainingConfig.trainerNames.map(n=>`<option value="${esc(n)}" ${currentTrainerIdentity===n?'selected':''}>${esc(n)}</option>`).join('');
}
async function saveTrainerIdentity(){
  currentTrainerIdentity = document.getElementById('trainerIdentitySelect').value;
  await setPersonal('current-trainer-identity', currentTrainerIdentity);
  toast(currentTrainerIdentity ? 'Marking attendance as '+currentTrainerIdentity : 'Identity cleared', 'ok');
  renderConductedBySelect();
  renderTrainerTable();
}

function renderSetupTab(){
  document.getElementById('maxInput').value = trainingConfig.maxCapacity;
  renderMasterPreview();
  renderTrainerNamesList();
  renderCoordinatorNamesList();
  renderTrainingNamesList();
  buildDaysFilterBar();
  renderDaysTable();
  loadCompletionCourseList();
}

function renderMasterPreview(){
  const bySup = {};
  masterData.forEach(p=>{ bySup[p.supervisor]=(bySup[p.supervisor]||0)+1; });
  document.getElementById('masterStats').innerHTML = `
    <div class="box"><b>${masterData.length}</b><span>Total Pharmacists</span></div>
    <div class="box"><b>${Object.keys(bySup).length}</b><span>Supervisors</span></div>
    <div class="box"><b>${pendingList.filter(p=>p.status==='Pending').length}</b><span>Pending Approval</span></div>`;
}

async function handleMasterUpload(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:false});
      if(!aoa.length){ toast('The file is empty','err'); input.value=''; return; }
      const headerRow = aoa[0].map(h=>String(h||'').trim());

      function findCol(regexList){
        for(const re of regexList){
          const idx = headerRow.findIndex(h=>re.test(h));
          if(idx !== -1) return idx;
        }
        return -1;
      }
      const autoIndices = {
        district: findCol([/^district$/i, /district/i]),
        areaManager: findCol([/area\s*manager/i, /\barea\b/i]),
        city: findCol([/^city$/i, /\bcity\b/i, /\bregion\b/i]),
        supervisor: findCol([/^supervisor/i, /supervisor/i]),
        pharmacyNo: findCol([/pharmacy\s*no/i, /pharmacy\s*(number|code|id)/i, /^pharmacy$/i, /branch\s*no/i, /outlet\s*no/i, /pharmacy/i]),
        employeeId: findCol([/employee\s*id/i, /emp\s*(no|number|code)/i, /staff\s*id/i, /user.*id/i, /^id$/i, /employee\s*no/i, /^emp/i]),
        email: findCol([/email/i]),
        displayName: findCol([/display.*name/i, /pharmacist.*name/i, /^name$/i]),
        phone: findCol([/phone/i, /whatsapp/i]),
        scfhs: findCol([/scfhs/i]),
        note: findCol([/^notes?$/i])
      };

      const mapping = await showColumnMappingModal(headerRow, autoIndices, aoa.length-1);
      if(!mapping){ toast('Import cancelled','info'); input.value=''; return; }

      const dataRows = aoa.slice(1);
      const rawParsed = dataRows.map(r=>({
        district: mapping.district!==-1 ? String(r[mapping.district]??'').trim() : '',
        areaManager: mapping.areaManager!==-1 ? String(r[mapping.areaManager]??'').trim() : '',
        city: mapping.city!==-1 ? String(r[mapping.city]??'').trim() : '',
        supervisor: mapping.supervisor!==-1 ? String(r[mapping.supervisor]??'').trim() : '',
        pharmacyNo: mapping.pharmacyNo!==-1 ? String(r[mapping.pharmacyNo]??'').trim() : '',
        employeeId: mapping.employeeId!==-1 ? String(r[mapping.employeeId]??'').trim() : '',
        email: mapping.email!==-1 ? String(r[mapping.email]??'').trim() : '',
        displayName: mapping.displayName!==-1 ? String(r[mapping.displayName]??'').trim() : '',
        phone: mapping.phone!==-1 ? String(r[mapping.phone]??'').trim() : '',
        scfhs: mapping.scfhs!==-1 ? String(r[mapping.scfhs]??'').trim() : '',
        note: mapping.note!==-1 ? String(r[mapping.note]??'').trim() : ''
      })).filter(p=>p.displayName && p.supervisor);

      if(!rawParsed.length){ toast('No usable rows found — check that the mapped Supervisor and Display Name columns actually contain data','err'); input.value=''; return; }

      const seen = new Map();
      rawParsed.forEach(p=>{
        const key = (p.email || (p.displayName+'|'+p.supervisor)).toLowerCase();
        if(!seen.has(key)) seen.set(key, p);
      });
      const parsed = [...seen.values()].map(p=>({id: uid('ph'), ...p}));
      const dupCount = rawParsed.length - parsed.length;

      if(masterData.length){
        const replace = await confirmDialog(`You currently have ${masterData.length} pharmacists saved. Uploading this file will replace them with ${parsed.length} unique pharmacists. Continue?`);
        if(!replace){ input.value=''; return; }
      }
      masterData = parsed;
      const ok = await setShared(K_MASTER, masterData);
      if(ok){
        toast(`Uploaded ${parsed.length} pharmacists` + (dupCount>0 ? ` (${dupCount} duplicate rows removed)` : ''), 'ok');
        renderMasterPreview();
      }
    }catch(err){
      console.error(err);
      toast('Error reading file: ' + (err.message||''), 'err');
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

async function handleCompletionUpload(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:false});
      if(!aoa.length){ toast('The file is empty','err'); input.value=''; return; }
      const headerRow = aoa[0].map(h=>String(h||'').trim());
      const emailIdx = headerRow.findIndex(h=>/email/i.test(h));
      const pctIdx = headerRow.findIndex(h=>/completion|progress|%/i.test(h));
      if(emailIdx===-1 || pctIdx===-1){
        toast('Could not detect an Email column and a Completion % column in this file','err');
        input.value=''; return;
      }
      const rows = aoa.slice(1).map(r=>({
        email: String(r[emailIdx]??'').trim().toLowerCase(),
        pct: String(r[pctIdx]??'').replace('%','').trim()
      })).filter(r=>r.email);

      const proceed = await confirmDialog(`This will match ${rows.length} rows by email against your ${masterData.length} pharmacists and update their Completion % field. Continue?`);
      if(!proceed){ input.value=''; return; }

      masterData = await getShared(K_MASTER, []);
      const byEmail = {};
      rows.forEach(r=>{ byEmail[r.email] = r.pct; });
      let matched = 0;
      masterData = masterData.map(p=>{
        const key = (p.email||'').trim().toLowerCase();
        if(key && byEmail[key] !== undefined){
          matched++;
          return {...p, completionPct: byEmail[key]};
        }
        return p;
      });
      const ok = await setShared(K_MASTER, masterData);
      if(ok){
        toast(`Matched and updated ${matched} of ${masterData.length} pharmacists`,'ok');
        renderMasterPreview();
      }
    }catch(err){
      console.error(err);
      toast('Error reading file: '+(err.message||''), 'err');
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

async function apsFetch(action, params){
  params = params || {};
  const qs = Object.entries(Object.assign({action:action}, params)).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  const url = APP_CONFIG.COMPLETION_REPORTS_URL + '?' + qs + '&_t=' + Date.now();
  const res = await fetch(url);
  if(!res.ok) throw new Error('HTTP '+res.status);
  return res.json();
}
function extractLearnerRate(l, totalModules){
  let rate = l.completionRate;
  if(l.modulesDone!==undefined && l.totalModules!==undefined && l.totalModules>0){
    rate = Math.round((l.modulesDone / l.totalModules) * 100);
  } else if(l.modulesCompleted!==undefined && totalModules>0){
    rate = Math.round((l.modulesCompleted / totalModules) * 100);
  } else if(typeof rate==='string'){
    rate = parseInt(rate,10) || 0;
  }
  if(typeof rate!=='number' || isNaN(rate)) rate = 0;
  return Math.min(100, Math.max(0, rate));
}
async function loadCompletionCourseList(){
  const sel = document.getElementById('completionCourseSelect');
  const statusEl = document.getElementById('completionSyncStatus');
  if(!sel) return;
  sel.innerHTML = `<option value="">Loading courses…</option>`;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  const saved = trainingConfig.completionCourse || '';
  try{
    const meta = await apsFetch('meta');
    const courses = meta.courses || [];
    sel.innerHTML = courses.length
      ? courses.map(c=>`<option value="${esc(c)}" ${c===saved?'selected':''}>${esc(c)}</option>`).join('')
      : `<option value="">No courses found</option>`;
    if(statusEl) statusEl.textContent = trainingConfig.completionLastSynced
      ? 'Last synced: '+new Date(trainingConfig.completionLastSynced).toLocaleString('en-GB')+(saved?' — '+saved:'')
      : '';
  }catch(err){
    console.error(err);
    sel.innerHTML = saved ? `<option value="${esc(saved)}" selected>${esc(saved)}</option>` : `<option value="">Could not connect</option>`;
    if(statusEl) statusEl.textContent = 'Could not reach the Training Completion Reports source — check your internet connection.';
  }
}
async function syncCompletionFromCourse(){
  const sel = document.getElementById('completionCourseSelect');
  const statusEl = document.getElementById('completionSyncStatus');
  const courseName = sel ? sel.value : '';
  if(!courseName){ toast('Choose a course first','err'); return; }
  if(statusEl) statusEl.textContent = 'Syncing…';
  try{
    const data = await apsFetch('course', {name: courseName});
    if(data.error) throw new Error(data.error);
    const learners = data.learners || [];
    const totalModules = data.totalModules || 0;
    const byEmail = {};
    learners.forEach(l=>{
      const em = (l.email||'').toLowerCase().trim();
      if(em) byEmail[em] = extractLearnerRate(l, totalModules);
    });

    masterData = await getShared(K_MASTER, []);
    let matched = 0;
    masterData = masterData.map(p=>{
      const key = (p.email||'').trim().toLowerCase();
      if(key && byEmail[key]!==undefined){
        matched++;
        return {...p, completionPct: byEmail[key]};
      }
      return p;
    });
    const ok = await setShared(K_MASTER, masterData);

    trainingConfig = await getShared(K_CONFIG, trainingConfig);
    trainingConfig.completionCourse = courseName;
    trainingConfig.completionLastSynced = new Date().toISOString();
    await setConfigWithHistory(trainingConfig);

    if(ok){
      toast(`Synced "${courseName}" — matched ${matched} of ${masterData.length} pharmacists`,'ok');
      if(statusEl) statusEl.textContent = 'Last synced: '+new Date(trainingConfig.completionLastSynced).toLocaleString('en-GB')+' — '+courseName;
      renderMasterPreview();
    }
  }catch(err){
    console.error(err);
    if(statusEl) statusEl.textContent = 'Sync failed — check your internet connection and try again.';
    toast('Could not sync completion rates: '+(err.message||''), 'err');
  }
}
async function clearMasterData(){
  const ok1 = await confirmDialog('Are you sure you want to clear all pharmacist data? This cannot be undone.');
  if(!ok1) return;
  masterData = [];
  const ok = await setShared(K_MASTER, masterData);
  if(ok){ renderMasterPreview(); toast('Data cleared','ok'); }
}

async function saveCapacitySettings(){
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  trainingConfig.maxCapacity = parseInt(document.getElementById('maxInput').value) || 30;
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok) toast('Setting saved','ok');
}

function promptText(title, label, defaultValue){
  return new Promise(resolve=>{
    showModal(`<h3>${esc(title)}</h3>
      <div class="field"><label class="field-label">${esc(label)}</label>
        <input type="text" id="txtPromptInput" value="${esc(defaultValue)}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline btn-sm" id="txtPromptCancel">Cancel</button>
        <button class="btn btn-navy btn-sm" id="txtPromptOk">Save</button>
      </div>`);
    const input = document.getElementById('txtPromptInput');
    input.focus();
    input.select();
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') document.getElementById('txtPromptOk').click(); });
    document.getElementById('txtPromptOk').onclick = ()=>{
      const val = input.value.trim();
      closeModal();
      resolve(val || null);
    };
    document.getElementById('txtPromptCancel').onclick = ()=>{ closeModal(); resolve(null); };
  });
}
function renderTrainerNamesList(){
  const box = document.getElementById('trainerNamesList');
  if(!trainingConfig.trainerNames.length){
    box.innerHTML = `<span class="small-note">No trainers added yet.</span>`;
    return;
  }
  box.innerHTML = trainingConfig.trainerNames.map(n=>{
    const c = trainerColor(n);
    return `<span class="badge" style="background:${c.bg};color:${c.text};border:1px solid ${c.text};display:inline-flex;align-items:center;gap:6px;">${esc(n)}
      <button style="background:none;border:none;color:${c.text};font-weight:800;padding:0 2px;" onclick="renameTrainerName('${esc(n)}')">✏️</button>
      <button style="background:none;border:none;color:${c.text};font-weight:800;padding:0 2px;" onclick="removeTrainerName('${esc(n)}')">✕</button>
    </span>`;
  }).join('');
}
async function renameTrainerName(oldName){
  const newName = await promptText('Rename Trainer', 'Trainer name', oldName);
  if(!newName || newName===oldName) return;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(trainingConfig.trainerNames.includes(newName)){ toast('That trainer name already exists','err'); return; }
  trainingConfig.trainerNames = trainingConfig.trainerNames.map(n=>n===oldName?newName:n);
  trainingConfig.dates.forEach(d=>{
    if(d.trainerNames) d.trainerNames = d.trainerNames.map(n=>n===oldName?newName:n);
  });
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    toast('Trainer renamed','ok');
    renderTrainerNamesList(); renderTrainerIdentitySelect(); renderConductedBySelect();
    renderDaysTable(); renderCalendar();
  }
}
async function addTrainerName(){
  const input = document.getElementById('newTrainerName');
  const name = input.value.trim();
  if(!name){ toast('Enter a trainer name','err'); return; }
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(trainingConfig.trainerNames.includes(name)){ toast('Trainer already exists','err'); return; }
  trainingConfig.trainerNames.push(name);
  const ok = await setConfigWithHistory(trainingConfig);
  input.value = '';
  if(ok){ toast('Trainer added','ok'); renderTrainerNamesList(); renderTrainerIdentitySelect(); renderConductedBySelect(); }
}
async function removeTrainerName(name){
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  trainingConfig.trainerNames = trainingConfig.trainerNames.filter(n=>n!==name);
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){ toast('Trainer removed','ok'); renderTrainerNamesList(); renderTrainerIdentitySelect(); renderConductedBySelect(); }
}

function renderCoordinatorNamesList(){
  const box = document.getElementById('coordinatorNamesList');
  if(!box) return;
  if(!trainingConfig.coordinatorNames.length){
    box.innerHTML = `<span class="small-note">No coordinators added yet.</span>`;
    return;
  }
  box.innerHTML = trainingConfig.coordinatorNames.map(n=>{
    return `<span class="badge" style="background:#fff;color:var(--navy);border:1px solid var(--navy);display:inline-flex;align-items:center;gap:6px;">${esc(n)}
      <button style="background:none;border:none;color:var(--navy);font-weight:800;padding:0 2px;" onclick="renameCoordinatorName('${esc(n)}')">✏️</button>
      <button style="background:none;border:none;color:var(--navy);font-weight:800;padding:0 2px;" onclick="removeCoordinatorName('${esc(n)}')">✕</button>
    </span>`;
  }).join('');
}
async function renameCoordinatorName(oldName){
  const newName = await promptText('Rename Coordinator', 'Coordinator name', oldName);
  if(!newName || newName===oldName) return;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(trainingConfig.coordinatorNames.includes(newName)){ toast('That coordinator name already exists','err'); return; }
  trainingConfig.coordinatorNames = trainingConfig.coordinatorNames.map(n=>n===oldName?newName:n);
  trainingConfig.dates.forEach(d=>{
    if(d.coordinator===oldName) d.coordinator = newName;
  });
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    toast('Coordinator renamed','ok');
    renderCoordinatorNamesList();
    renderDaysTable();
  }
}
async function addCoordinatorName(){
  const input = document.getElementById('newCoordinatorName');
  const name = input.value.trim();
  if(!name){ toast('Enter a coordinator name','err'); return; }
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(!trainingConfig.coordinatorNames) trainingConfig.coordinatorNames = [];
  if(trainingConfig.coordinatorNames.includes(name)){ toast('Coordinator already exists','err'); return; }
  trainingConfig.coordinatorNames.push(name);
  const ok = await setConfigWithHistory(trainingConfig);
  input.value = '';
  if(ok){ toast('Coordinator added','ok'); renderCoordinatorNamesList(); }
}
async function removeCoordinatorName(name){
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  trainingConfig.coordinatorNames = trainingConfig.coordinatorNames.filter(n=>n!==name);
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){ toast('Coordinator removed','ok'); renderCoordinatorNamesList(); }
}

function renderTrainingNamesList(){
  const box = document.getElementById('trainingNamesList');
  if(!box) return;
  if(!trainingConfig.trainingNames.length){
    box.innerHTML = `<span class="small-note">No training names added yet.</span>`;
    return;
  }
  box.innerHTML = trainingConfig.trainingNames.map(n=>`
    <span class="badge badge-date" style="display:inline-flex;align-items:center;gap:6px;">${esc(n)}
      <button style="background:none;border:none;color:var(--navy);font-weight:800;padding:0 2px;" onclick="renameTrainingName('${esc(n)}')">✏️</button>
      <button style="background:none;border:none;color:var(--danger);font-weight:800;padding:0 2px;" onclick="removeTrainingName('${esc(n)}')">✕</button>
    </span>`).join('');
}
async function renameTrainingName(oldName){
  const newName = await promptText('Rename Training Name', 'Training name', oldName);
  if(!newName || newName===oldName) return;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(trainingConfig.trainingNames.includes(newName)){ toast('That training name already exists','err'); return; }
  trainingConfig.trainingNames = trainingConfig.trainingNames.map(n=>n===oldName?newName:n);
  trainingConfig.dates.forEach(d=>{
    if(d.trainingName===oldName) d.trainingName = newName;
  });
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    toast('Training name renamed','ok');
    renderTrainingNamesList();
    renderDaysTable(); renderCalendar();
  }
}
async function addTrainingName(){
  const input = document.getElementById('newTrainingName');
  const name = input.value.trim();
  if(!name){ toast('Enter a training name','err'); return; }
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(trainingConfig.trainingNames.includes(name)){ toast('Already exists','err'); return; }
  trainingConfig.trainingNames.push(name);
  const ok = await setConfigWithHistory(trainingConfig);
  input.value = '';
  if(ok){ toast('Training name added','ok'); renderTrainingNamesList(); }
}
async function removeTrainingName(name){
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  trainingConfig.trainingNames = trainingConfig.trainingNames.filter(n=>n!==name);
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){ toast('Removed','ok'); renderTrainingNamesList(); }
}

// defaults to date-ascending (the table's natural order), so the indicator/toggle direction always matches what's on screen
let daysSortState = {key:'date', dir:1};
function toggleDaysSort(key){
  if(daysSortState.key===key) daysSortState.dir*=-1; else { daysSortState.key=key; daysSortState.dir=1; }
  renderDaysTable();
}
function getDaysSortValue(d, key){
  if(key==='date') return d.date;
  if(key==='city') return (d.city||'').toLowerCase();
  if(key==='assigned') return dayCount(d.id);
  return '';
}
function updateDaysSortIndicators(){
  document.querySelectorAll('[id^="sort-days-"]').forEach(el=>{
    const key = el.id.replace('sort-days-','');
    el.textContent = daysSortState.key===key ? (daysSortState.dir===1?'▲':'▼') : '';
  });
}

function renderDaysTable(){
  const tb = document.getElementById('daysTableBody');
  if(!trainingConfig.dates.length){
    tb.innerHTML = `<tr><td colspan="7" class="empty-msg"><div class="ic">📅</div>No training days configured yet</td></tr>`;
    updateDaysSortIndicators();
    return;
  }
  const filteredDates = trainingConfig.dates.filter(dayMatchesFilters);
  if(!filteredDates.length){
    tb.innerHTML = `<tr><td colspan="7" class="empty-msg">No training days match the current filters</td></tr>`;
    updateDaysSortIndicators();
    return;
  }
  let sortedDates = [...filteredDates];
  sortedDates.sort((a,b)=>{
    const va = getDaysSortValue(a, daysSortState.key), vb = getDaysSortValue(b, daysSortState.key);
    if(va<vb) return -1*daysSortState.dir;
    if(va>vb) return 1*daysSortState.dir;
    return 0;
  });
  tb.innerHTML = sortedDates.map((d,i)=>{
    const count = dayCount(d.id);
    const isActive = d.active!==false;
    const visText = (!d.visibleSupervisors || !d.visibleSupervisors.length) ? '— none —' : d.visibleSupervisors.join(', ');
    const trainers = (d.trainerNames && d.trainerNames.length) ? d.trainerNames.map(trainerBadge).join(' ') : '<span class="small-note">— none —</span>';
    const typeText = d.type || 'Pharmacist Training';
    const onlineText = d.isOnline ? `<br><span class="badge badge-date">Online — ${d.onlineFormat==='fullday'?'1 day':'split, 2 days'}${d.coordinator?' — '+esc(d.coordinator):''}</span>${d.zoomLink?` <a href="${esc(d.zoomLink)}" target="_blank" style="font-size:10.5px;">Zoom link</a>`:''}` : '';
    return `<tr style="${isActive?'':'opacity:.55;'}">
      <td>${i+1}</td>
      <td>${dayDateLabel(d)} ${isActive?'':'<span class="badge badge-empty">Hidden</span>'}</td>
      <td><span class="city-badge">${esc(d.city)}</span>${d.trainingName?'<br><span class="small-note">'+esc(d.trainingName)+'</span>':''}<br><span class="badge badge-leave">${esc(typeText)}</span>${onlineText}</td>
      <td>${trainers}</td>
      <td style="white-space:normal;max-width:200px;">${esc(visText)}</td>
      <td>${count} / ${dayCapacity(d)} ${d.capacity?'<span class="badge badge-date">Custom</span>':''}${d.deadline?`<br><span class="small-note" style="${isDeadlinePassed(d)?'color:var(--danger);font-weight:700;':''}">Deadline: ${formatDateTime(d.deadline)}${isDeadlinePassed(d)?' (Passed)':''}</span>`:''}</td>
      <td class="row no-truncate" style="gap:4px;flex-wrap:nowrap;padding-top:9px;padding-bottom:9px;">
        <button class="btn btn-outline btn-sm btn-icon" title="${isActive?'Hide':'Unhide'}" onclick="toggleDayActive('${d.id}')">${isActive?'<img src="data:image/png;base64,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" style="width:16px;height:16px;display:block;" alt="">':'<img src="data:image/png;base64,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" style="width:16px;height:16px;display:block;" alt="">'}</button>
        <button class="btn btn-outline btn-sm btn-icon" title="Status" onclick="openDayStatusModal('${d.id}')"><img src="data:image/png;base64,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" style="width:16px;height:16px;display:block;" alt=""></button>
        <button class="btn btn-outline btn-sm btn-icon" title="Duplicate" onclick="duplicateDay('${d.id}')"><img src="data:image/png;base64,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" style="width:16px;height:16px;display:block;" alt=""></button>
        <button class="btn btn-outline btn-sm btn-icon" title="Edit" onclick="openEditDayModal('${d.id}')"><img src="data:image/png;base64,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" style="width:16px;height:16px;display:block;" alt=""></button>
        <button class="btn btn-danger btn-sm btn-icon" title="Delete" onclick="deleteDay('${d.id}', ${count})"><img src="data:image/png;base64,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" style="width:16px;height:16px;display:block;" alt=""></button>
      </td>
    </tr>`;
  }).join('');
  updateDaysSortIndicators();
}

function openEditDayModal(dayId){
  const day = trainingConfig.dates.find(d=>d.id===dayId);
  if(!day) return;
  const supNames = sortSupervisorNames([...new Set(masterData.map(p=>p.supervisor).filter(isValidSupervisorName))]);
  const supCheckboxes = supNames.map(n=>`<label><input type="checkbox" class="edit-day-sup-cb" value="${esc(n)}" onchange="syncQuotaVisibility('edit')" ${day.visibleSupervisors&&day.visibleSupervisors.includes(n)?'checked':''}> ${esc(n)}</label>`).join('') || '<span class="small-note">No supervisors found.</span>';
  const trainerCheckboxes = trainingConfig.trainerNames.map(n=>`<label><input type="checkbox" class="edit-day-trainer-cb" value="${esc(n)}" ${day.trainerNames&&day.trainerNames.includes(n)?'checked':''}> ${esc(n)}</label>`).join('') || '<span class="small-note">No trainers in the roster yet.</span>';
  const dayCityKnown = isKnownCity(day.city);
  const trainingNameOptions = trainingConfig.trainingNames.map(n=>`<option value="${esc(n)}" ${day.trainingName===n?'selected':''}>${esc(n)}</option>`).join('');
  const typeOptions = TRAINING_DAY_TYPES.map(t=>`<option value="${t}" ${(day.type||'Pharmacist Training')===t?'selected':''}>${t}</option>`).join('');
  const coordinatorOptions = trainingConfig.coordinatorNames.map(n=>`<option value="${esc(n)}" ${day.coordinator===n?'selected':''}>${esc(n)}</option>`).join('');
  const isActive = day.active!==false;

  showModal(`
    <h3>Edit Training Day</h3>
    <div class="field"><label class="field-label req">Date</label><input type="date" id="editDayDate" value="${esc(day.date)}" oninput="updateEditSplitPreview()"></div>
    <div class="field"><label class="field-label req">City</label>
      <select id="editDayCity" onchange="onCitySelectChange('editDayCity','editDayCityCustom')">
        <option value="">-- Select City --</option>
        ${cityOptionsHtml(day.city)}
        <option value="__new__" ${dayCityKnown?'':'selected'}>+ Add a new city…</option>
      </select>
      <input type="text" id="editDayCityCustom" placeholder="Enter new city name" value="${dayCityKnown?'':esc(day.city)}" class="${dayCityKnown?'hidden':''}" style="margin-top:8px;">
    </div>
    <div class="field"><label class="field-label">Training Name (optional)</label><select id="editDayTrainingName"><option value="">-- None --</option>${trainingNameOptions}</select></div>
    <div class="field"><label class="field-label">Type</label><select id="editDayType">${typeOptions}</select></div>
    <div class="field"><label class="field-label">Venue (optional)</label><input type="text" id="editDayVenue" list="venueDatalist" value="${esc(day.venue||'')}" placeholder="Pick from the Venues tab or type one">${venueDatalistHtml()}</div>
    <div class="field"><label class="field-label">Custom capacity (blank = default ${trainingConfig.maxCapacity})</label><input type="number" id="editDayCapacity" value="${day.capacity||''}" placeholder="${trainingConfig.maxCapacity}"></div>
    <div class="field"><label class="field-label">Supervisor assignment deadline — date &amp; time (optional)</label><input type="datetime-local" id="editDayDeadline" value="${esc(day.deadline||'')}"><p class="small-note">After this date and time, supervisors can no longer assign new pharmacists to this day.</p></div>
    <div class="field"><label class="toggle-label"><input type="checkbox" id="editDayActive" ${isActive?'checked':''}> Active (visible to supervisors)</label></div>
    <div class="field">
      <label class="field-label">Trainer(s)</label>
      <div class="row" style="margin-bottom:6px;">
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('edit-day-trainer-cb', true)">Select All</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('edit-day-trainer-cb', false)">Clear All</button>
      </div>
      <div class="checkbox-list" style="max-height:120px;">${trainerCheckboxes}</div>
    </div>
    <div class="field">
      <label class="toggle-label"><input type="checkbox" id="editDayIsOnline" onchange="toggleEditOnlineFields(this)" ${day.isOnline?'checked':''}> This is an online training</label>
    </div>
    <div id="editOnlineFieldsBlock" class="${day.isOnline?'':'hidden'}">
      <div class="field">
        <label class="field-label">Format</label>
        <select id="editDayOnlineFormat" onchange="updateEditSplitPreview()">
          <option value="split" ${day.onlineFormat!=='fullday'?'selected':''}>Split — 3 hours over 2 days (default)</option>
          <option value="fullday" ${day.onlineFormat==='fullday'?'selected':''}>Full day — 1 day</option>
        </select>
        <p class="small-note" id="editDaySplitPreview" style="margin-top:6px;color:var(--navy);font-weight:600;"></p>
      </div>
      <div class="field"><label class="field-label">Coordinator (optional)</label><select id="editDayCoordinator"><option value="">-- None --</option>${coordinatorOptions}</select></div>
      <div class="field"><label class="field-label">Zoom Link (optional)</label><input type="text" id="editDayZoomLink" value="${esc(day.zoomLink||'')}" placeholder="https://zoom.us/j/..."></div>
      <div class="field">
        <label class="field-label">Per-Supervisor Quota (optional — blank = unlimited)</label>
        <p class="small-note">Once a supervisor reaches their quota, further assignments they make need your approval.</p>
        <div class="checkbox-list" style="max-height:160px;">
          ${sortSupervisorNames([...new Set(masterData.map(p=>p.supervisor).filter(isValidSupervisorName))]).map(n=>`
            <label style="justify-content:space-between;" data-quota-row="edit" data-sup="${esc(n)}" class="${day.visibleSupervisors&&day.visibleSupervisors.includes(n)?'':'hidden'}"><span>${esc(n)}</span><input type="number" class="edit-day-quota-input" data-sup="${esc(n)}" value="${(day.supervisorQuotas&&day.supervisorQuotas[n])||''}" style="width:70px;" min="0" placeholder="∞"></label>
          `).join('') || '<span class="small-note">No supervisors found.</span>'}
          <span class="small-note" id="editQuotaEmptyMsg">Check supervisors in "Visible to" below to set a quota for each.</span>
        </div>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Visible to (optional)</label>
      <div class="row" style="margin-bottom:6px;">
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('edit-day-sup-cb', true)">Select All</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('edit-day-sup-cb', false)">Clear All</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="autoSelectCitySupervisors(readCityFieldValue('editDayCity','editDayCityCustom'))">Auto-select by city</button>
      </div>
      <div class="checkbox-list">${supCheckboxes}</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger btn-sm" style="margin-right:auto;" onclick="deleteDay('${dayId}', ${dayCount(dayId)})">🗑 Delete This Day</button>
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" onclick="confirmEditDay('${dayId}')">Save</button>
    </div>`);
  syncQuotaVisibility('edit');
  updateEditSplitPreview();
}
function selectAllCb(className, checked){
  document.querySelectorAll('.'+className).forEach(cb=>cb.checked = checked);
  if(className==='day-sup-cb') syncQuotaVisibility('new');
  if(className==='edit-day-sup-cb') syncQuotaVisibility('edit');
}
function syncQuotaVisibility(scope){
  const cbClass = scope==='edit' ? 'edit-day-sup-cb' : 'day-sup-cb';
  const checked = new Set([...document.querySelectorAll('.'+cbClass+':checked')].map(cb=>cb.value));
  let anyVisible = false;
  document.querySelectorAll(`[data-quota-row="${scope}"]`).forEach(row=>{
    const show = checked.has(row.dataset.sup);
    row.classList.toggle('hidden', !show);
    if(show) anyVisible = true;
  });
  const emptyMsg = document.getElementById(scope+'QuotaEmptyMsg');
  if(emptyMsg) emptyMsg.classList.toggle('hidden', anyVisible);
}
function toggleEditOnlineFields(cb){
  document.getElementById('editOnlineFieldsBlock').classList.toggle('hidden', !cb.checked);
  updateEditSplitPreview();
}
function splitPreviewText(dateStr){
  const d1 = new Date(dateStr+'T00:00:00');
  if(isNaN(d1)) return '';
  const d2 = new Date(d1);
  d2.setDate(d2.getDate()+1);
  const label2 = `${d2.getDate()} ${MONTHS[d2.getMonth()]} ${String(d2.getFullYear()).slice(-2)}`;
  return `📅 This training runs over 2 days: ${formatDate(dateStr)} and ${label2}`;
}
function updateEditSplitPreview(){
  const preview = document.getElementById('editDaySplitPreview');
  if(!preview) return;
  const isOnline = document.getElementById('editDayIsOnline').checked;
  const fmt = document.getElementById('editDayOnlineFormat') ? document.getElementById('editDayOnlineFormat').value : '';
  const dateVal = document.getElementById('editDayDate').value;
  preview.textContent = (isOnline && fmt==='split' && dateVal) ? splitPreviewText(dateVal) : '';
}
function updateNewSplitPreview(){
  const preview = document.getElementById('newDaySplitPreview');
  if(!preview) return;
  const isOnlineCb = document.getElementById('newDayIsOnline');
  const isOnline = isOnlineCb && isOnlineCb.checked;
  const fmt = document.getElementById('newDayOnlineFormat') ? document.getElementById('newDayOnlineFormat').value : '';
  const dateInputs = document.querySelectorAll('.day-date-input');
  if(!isOnline || fmt!=='split' || dateInputs.length!==1 || !dateInputs[0].value){
    preview.textContent = '';
    return;
  }
  preview.textContent = splitPreviewText(dateInputs[0].value);
}
async function confirmEditDay(dayId){
  const date = document.getElementById('editDayDate').value;
  const city = readCityFieldValue('editDayCity','editDayCityCustom');
  const trainingName = document.getElementById('editDayTrainingName').value;
  const type = document.getElementById('editDayType').value || 'Pharmacist Training';
  const capVal = parseInt(document.getElementById('editDayCapacity').value);
  const deadline = document.getElementById('editDayDeadline').value || null;
  const active = document.getElementById('editDayActive').checked;
  const trainerNames = [...document.querySelectorAll('.edit-day-trainer-cb:checked')].map(cb=>cb.value);
  const isOnline = document.getElementById('editDayIsOnline').checked;
  const onlineFormat = isOnline ? document.getElementById('editDayOnlineFormat').value : '';
  const coordinator = isOnline ? document.getElementById('editDayCoordinator').value : '';
  const zoomLink = isOnline ? document.getElementById('editDayZoomLink').value.trim() : '';
  const venue = document.getElementById('editDayVenue').value.trim();
  const supervisorQuotas = {};
  if(isOnline){
    const visibleForQuota = new Set([...document.querySelectorAll('.edit-day-sup-cb:checked')].map(cb=>cb.value));
    document.querySelectorAll('.edit-day-quota-input').forEach(inp=>{
      const v = parseInt(inp.value);
      if(v>=0 && visibleForQuota.has(inp.dataset.sup)) supervisorQuotas[inp.dataset.sup] = v;
    });
  }
  const visibleSupervisors = [...document.querySelectorAll('.edit-day-sup-cb:checked')].map(cb=>cb.value);
  if(!date){ toast('Please select a date','err'); return; }
  if(!city){ toast('Please enter a city','err'); return; }
  if(isOnline && onlineFormat==='split' && new Date(date+'T00:00:00').getDay()===5){
    toast('Split online trainings cannot be scheduled on a Friday — please choose a different date','err');
    return;
  }

  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(trainingName && !trainingConfig.trainingNames.includes(trainingName)){
    trainingConfig.trainingNames.push(trainingName);
  }
  const day = trainingConfig.dates.find(d=>d.id===dayId);
  if(day){
    Object.assign(day, {
      date, city, trainingName, type, capacity: (capVal && capVal>0) ? capVal : null, deadline, active,
      trainerNames, isOnline, onlineFormat, coordinator, zoomLink, venue, supervisorQuotas, visibleSupervisors
    });
  }
  const ok = await setConfigWithHistory(trainingConfig);
  closeModal();
  if(ok){
    toast('Training day updated','ok');
    buildDaysFilterBar();
    renderDaysTable();
    buildTrainerFilterBar();
    renderCalendar();
  }
}

function suggestedSupervisorsForCity(city){
  return sortSupervisorNames([...new Set(masterData.filter(p=>p.city===city).map(p=>p.supervisor).filter(isValidSupervisorName))]);
}
function cityOptionsHtml(selectedCity){
  const cities = [...new Set(masterData.map(p=>p.city).filter(Boolean))].sort();
  return cities.map(c=>`<option value="${esc(c)}" ${c===selectedCity?'selected':''}>${esc(c)}</option>`).join('');
}
function isKnownCity(city){
  return !!city && [...new Set(masterData.map(p=>p.city).filter(Boolean))].includes(city);
}
function onCitySelectChange(selectId, customId){
  const sel = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  if(!sel || !custom) return;
  const show = sel.value==='__new__';
  custom.classList.toggle('hidden', !show);
  if(show) custom.focus();
}
function readCityFieldValue(selectId, customId){
  const sel = document.getElementById(selectId);
  if(!sel) return '';
  if(sel.value==='__new__') return (document.getElementById(customId).value||'').trim();
  return sel.value;
}
function autoSelectCitySupervisors(cityForMatch){
  const suggested = suggestedSupervisorsForCity(cityForMatch);
  document.querySelectorAll('.edit-day-sup-cb').forEach(cb=>{
    if(suggested.includes(cb.value)) cb.checked = true;
  });
  syncQuotaVisibility('edit');
  toast(`Checked ${suggested.length} supervisor(s) matching ${cityForMatch}`, 'ok');
}

const TRAINING_DAY_TYPES = ['Pharmacist Training','Onboarding','HQ'];

/* Venues come from the "Venues" tab of the Google Sheet (city → recommended hotel/venue). */
let venueList = [];
async function loadVenues(){
  try{ venueList = await API.venues(); }catch(e){ console.error(e); venueList = []; }
}
function venueDatalistHtml(){
  return '<datalist id="venueDatalist">' + venueList.map(v=>`<option value="${esc(v.venue)}">${esc(v.city)}</option>`).join('') + '</datalist>';
}

function openAddDayModal(presetDate){
  const supNames = sortSupervisorNames([...new Set(masterData.map(p=>p.supervisor).filter(isValidSupervisorName))]);
  const checkboxes = supNames.map(n=>`<label><input type="checkbox" class="day-sup-cb" value="${esc(n)}" onchange="syncQuotaVisibility('new')"> ${esc(n)}</label>`).join('') || '<span class="small-note">No supervisors found in the master data yet.</span>';
  const trainerCheckboxes = trainingConfig.trainerNames.map(n=>`<label><input type="checkbox" class="day-trainer-cb-new" value="${esc(n)}"> ${esc(n)}</label>`).join('') || '<span class="small-note">No trainers in the roster yet — add some below in Setup.</span>';
  const typeOptions = TRAINING_DAY_TYPES.map(t=>`<option value="${t}" ${t==='Pharmacist Training'?'selected':''}>${t}</option>`).join('');
  const trainingNameOptions = trainingConfig.trainingNames.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
  const coordinatorOptions = trainingConfig.coordinatorNames.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
  const dateVal = (typeof presetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(presetDate)) ? presetDate : '';
  showModal(`
    <h3>Add Training Day(s)</h3>
    <p class="small-note">Add several dates at once for the same city and supervisors — handy for scheduling a full week for a region in one go.</p>
    <div class="field">
      <label class="field-label req">Date(s)</label>
      <div id="dayDatesContainer"><div class="row" style="margin-bottom:6px;"><input type="date" class="day-date-input" value="${dateVal}" oninput="updateNewSplitPreview()"></div></div>
      <button type="button" class="btn btn-outline btn-sm" onclick="addAnotherDateRow()">+ Add another date</button>
    </div>
    <div class="field"><label class="field-label req">City</label>
      <select id="newDayCity" onchange="onCitySelectChange('newDayCity','newDayCityCustom')">
        <option value="">-- Select City --</option>
        ${cityOptionsHtml('')}
        <option value="__new__">+ Add a new city…</option>
      </select>
      <input type="text" id="newDayCityCustom" placeholder="Enter new city name" class="hidden" style="margin-top:8px;">
    </div>
    <div class="field"><label class="field-label">Training Name (optional)</label><select id="newDayTrainingName"><option value="">-- None --</option>${trainingNameOptions}</select></div>
    <div class="field"><label class="field-label">Type</label><select id="newDayType">${typeOptions}</select></div>
    <div class="field"><label class="field-label">Venue (optional)</label><input type="text" id="newDayVenue" list="venueDatalist" placeholder="Pick from the Venues tab or type one">${venueDatalistHtml()}</div>
    <div class="field"><label class="field-label">Supervisor assignment deadline — date &amp; time (optional)</label><input type="datetime-local" id="newDayDeadline"><p class="small-note">After this date and time, supervisors can no longer assign new pharmacists to this day.</p></div>
    <div class="field">
      <label class="field-label">Assign Trainer(s) (optional)</label>
      <div class="row" style="margin-bottom:6px;">
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('day-trainer-cb-new', true)">Select All</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('day-trainer-cb-new', false)">Clear All</button>
      </div>
      <div class="checkbox-list" style="max-height:120px;">${trainerCheckboxes}</div>
    </div>
    <div class="field">
      <label class="toggle-label"><input type="checkbox" id="newDayIsOnline" onchange="toggleOnlineFields(this)"> This is an online training</label>
    </div>
    <div id="onlineFieldsBlock" class="hidden">
      <div class="field">
        <label class="field-label">Format</label>
        <select id="newDayOnlineFormat" onchange="updateNewSplitPreview()">
          <option value="split" selected>Split — 3 hours over 2 days (default)</option>
          <option value="fullday">Full day — 1 day</option>
        </select>
        <p class="small-note" id="newDaySplitPreview" style="margin-top:6px;color:var(--navy);font-weight:600;"></p>
      </div>
      <div class="field"><label class="field-label">Coordinator (optional)</label><select id="newDayCoordinator"><option value="">-- None --</option>${coordinatorOptions}</select></div>
      <div class="field"><label class="field-label">Zoom Link (optional)</label><input type="text" id="newDayZoomLink" placeholder="https://zoom.us/j/..."></div>
      <div class="field">
        <label class="field-label">Per-Supervisor Quota (optional — blank = unlimited)</label>
        <p class="small-note">Once a supervisor reaches their quota, further assignments they make need your approval.</p>
        <div class="checkbox-list" style="max-height:160px;">
          ${sortSupervisorNames([...new Set(masterData.map(p=>p.supervisor).filter(isValidSupervisorName))]).map(n=>`
            <label style="justify-content:space-between;" data-quota-row="new" data-sup="${esc(n)}" class="hidden"><span>${esc(n)}</span><input type="number" class="new-day-quota-input" data-sup="${esc(n)}" style="width:70px;" min="0" placeholder="∞"></label>
          `).join('') || '<span class="small-note">No supervisors found.</span>'}
          <span class="small-note" id="newQuotaEmptyMsg">Check supervisors in "Visible to" below to set a quota for each.</span>
        </div>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Visible to (optional — select which supervisors can see these days)</label>
      <div class="row" style="margin-bottom:6px;">
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('day-sup-cb', true)">Select All</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="selectAllCb('day-sup-cb', false)">Clear All</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="autoSelectByCityGeneric('newDayCity','day-sup-cb')">Auto-select by city</button>
      </div>
      <div class="checkbox-list">${checkboxes}</div>
    </div>
    <div class="field">
      <label class="field-label">Optional: Upload expected attendee list (Excel with an Email column)</label>
      <p class="small-note">Only applies when adding a single date. Matched pharmacists are assigned to this day automatically.</p>
      <input type="file" id="newDayRosterFile" accept=".xlsx,.xls,.csv">
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" onclick="confirmAddDay()">Add Day(s)</button>
    </div>`);
  syncQuotaVisibility('new');
}
function toggleOnlineFields(cb){
  document.getElementById('onlineFieldsBlock').classList.toggle('hidden', !cb.checked);
  updateNewSplitPreview();
}
function addAnotherDateRow(){
  const container = document.getElementById('dayDatesContainer');
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginBottom = '6px';
  row.innerHTML = `<input type="date" class="day-date-input" oninput="updateNewSplitPreview()"> <button type="button" class="btn btn-outline btn-sm" onclick="this.parentElement.remove(); updateNewSplitPreview();">✕</button>`;
  container.appendChild(row);
  updateNewSplitPreview();
}
function autoSelectByCityGeneric(cityFieldId, checkboxClass){
  const city = readCityFieldValue(cityFieldId, cityFieldId+'Custom');
  if(!city){ toast('Enter a city first','err'); return; }
  const suggested = suggestedSupervisorsForCity(city);
  document.querySelectorAll('.'+checkboxClass).forEach(cb=>{
    if(suggested.includes(cb.value)) cb.checked = true;
  });
  if(checkboxClass==='day-sup-cb') syncQuotaVisibility('new');
  toast(`Checked ${suggested.length} supervisor(s) matching ${city}`, 'ok');
}
async function confirmAddDay(){
  const dates = [...document.querySelectorAll('.day-date-input')].map(el=>el.value).filter(Boolean);
  const uniqueDates = [...new Set(dates)];
  const city = readCityFieldValue('newDayCity','newDayCityCustom');
  const trainingName = document.getElementById('newDayTrainingName').value;
  const type = document.getElementById('newDayType').value || 'Pharmacist Training';
  const deadline = document.getElementById('newDayDeadline').value || null;
  const trainerNames = [...document.querySelectorAll('.day-trainer-cb-new:checked')].map(cb=>cb.value);
  const isOnline = document.getElementById('newDayIsOnline').checked;
  const onlineFormat = isOnline ? document.getElementById('newDayOnlineFormat').value : '';
  const coordinator = isOnline ? document.getElementById('newDayCoordinator').value : '';
  const zoomLink = isOnline ? document.getElementById('newDayZoomLink').value.trim() : '';
  const venue = document.getElementById('newDayVenue').value.trim();
  const supervisorQuotas = {};
  if(isOnline){
    const visibleForQuota = new Set([...document.querySelectorAll('.day-sup-cb:checked')].map(cb=>cb.value));
    document.querySelectorAll('.new-day-quota-input').forEach(inp=>{
      const v = parseInt(inp.value);
      if(v>=0 && visibleForQuota.has(inp.dataset.sup)) supervisorQuotas[inp.dataset.sup] = v;
    });
  }
  const visibleSupervisors = [...document.querySelectorAll('.day-sup-cb:checked')].map(cb=>cb.value);
  const rosterFile = document.getElementById('newDayRosterFile').files[0];
  if(!uniqueDates.length){ toast('Please select at least one date','err'); return; }
  if(!city){ toast('Please enter a city','err'); return; }
  if(isOnline && onlineFormat==='split'){
    const fridayDates = uniqueDates.filter(d => new Date(d+'T00:00:00').getDay()===5);
    if(fridayDates.length){
      toast('Split online trainings cannot be scheduled on a Friday — please choose a different date','err');
      return;
    }
  }

  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  if(trainingName && !trainingConfig.trainingNames.includes(trainingName)){
    trainingConfig.trainingNames.push(trainingName);
  }
  const newDayIds = [];
  uniqueDates.forEach(date=>{
    const id = uid('day');
    newDayIds.push(id);
    trainingConfig.dates.push({id, date, city, trainingName, type, deadline, trainerNames, isOnline, onlineFormat, coordinator, zoomLink, venue, supervisorQuotas, visibleSupervisors, active:true});
  });
  const ok = await setConfigWithHistory(trainingConfig);
  closeModal();
  if(!ok) return;
  toast(`${uniqueDates.length} training day(s) added`,'ok');

  if(rosterFile && uniqueDates.length===1){
    await importDayRoster(rosterFile, newDayIds[0]);
  }
  buildDaysFilterBar();
  renderDaysTable();
  buildTrainerFilterBar();
  renderTrainerNamesList();
}

async function importDayRoster(file, dayId){
  return new Promise(resolve=>{
    const reader = new FileReader();
    reader.onload = async (e)=>{
      try{
        const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:false});
        if(!aoa.length){ toast('Roster file was empty — day created without a pre-filled list','info'); resolve(); return; }
        const headerRow = aoa[0].map(h=>String(h||'').trim());
        const emailIdx = headerRow.findIndex(h=>/email/i.test(h));
        if(emailIdx===-1){ toast('Could not find an Email column in the roster file','err'); resolve(); return; }
        const emails = aoa.slice(1).map(r=>String(r[emailIdx]??'').trim().toLowerCase()).filter(Boolean);
        masterData = await getShared(K_MASTER, []);
        ops = await getShared(K_OPS, {assignments:{}, attendance:{}});
        let matched = 0;
        emails.forEach(email=>{
          const p = masterData.find(m=>(m.email||'').toLowerCase()===email);
          if(p){
            ops.assignments[p.id] = {type:'date', dateId:dayId, assignedBy:'Trainer (roster upload)', assignedAt: nowIso()};
            matched++;
          }
        });
        const ok = await setShared(K_OPS, ops);
        if(ok) toast(`Roster matched ${matched} of ${emails.length} emails and assigned them to this day`,'ok');
      }catch(err){
        console.error(err);
        toast('Error reading roster file: '+(err.message||''),'err');
      }
      resolve();
    };
    reader.readAsArrayBuffer(file);
  });
}

async function deleteDay(dayId, count){
  const msg = count>0
    ? `${count} pharmacist(s) are currently assigned to this day. Deleting it will move them back to Not Assigned. Continue?`
    : 'Delete this training day?';
  const go = await confirmDialog(msg);
  if(!go) return;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  trainingConfig.dates = trainingConfig.dates.filter(d=>d.id!==dayId);
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    ops = await getShared(K_OPS, {assignments:{}, attendance:{}});
    let cleaned = false;
    Object.keys(ops.assignments).forEach(pid=>{
      if(ops.assignments[pid].type==='date' && ops.assignments[pid].dateId===dayId){
        delete ops.assignments[pid];
        delete ops.attendance[pid];
        cleaned = true;
      }
    });
    if(cleaned) await setShared(K_OPS, ops);
    toast('Day deleted','ok');
    closeModal();
    buildDaysFilterBar();
    renderDaysTable();
    renderCalendar();
    buildTrainerFilterBar();
  }
}

async function duplicateDay(dayId){
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  const day = trainingConfig.dates.find(d=>d.id===dayId);
  if(!day) return;
  const copy = JSON.parse(JSON.stringify(day));
  copy.id = uid('day');
  trainingConfig.dates.push(copy);
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    toast('Day duplicated — edit the copy below','ok');
    buildDaysFilterBar();
    renderDaysTable();
    buildTrainerFilterBar();
    renderCalendar();
    openEditDayModal(copy.id);
  }
}

async function toggleDayActive(dayId){
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  const day = trainingConfig.dates.find(d=>d.id===dayId);
  if(!day) return;
  day.active = day.active===false ? true : false;
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    toast(day.active ? 'Day unhidden' : 'Day hidden from supervisors (existing assignments untouched, still visible on the Calendar)','ok');
    renderDaysTable();
    buildTrainerFilterBar();
    renderCalendar();
  }
}

async function deleteAllDays(){
  if(!trainingConfig.dates.length){ toast('No training days to delete','info'); return; }
  const go = await confirmDialog(`This will permanently delete all ${trainingConfig.dates.length} training day(s). Any pharmacists assigned to them will move back to Not Assigned. This cannot be undone. Continue?`);
  if(!go) return;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  trainingConfig.dates = [];
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    ops = await getShared(K_OPS, {assignments:{}, attendance:{}});
    let cleaned = false;
    Object.keys(ops.assignments).forEach(pid=>{
      if(ops.assignments[pid].type==='date'){
        delete ops.assignments[pid];
        delete ops.attendance[pid];
        cleaned = true;
      }
    });
    if(cleaned) await setShared(K_OPS, ops);
    toast('All training days deleted','ok');
    buildDaysFilterBar();
    renderDaysTable();
    buildTrainerFilterBar();
    renderCalendar();
  }
}

async function hideAllDays(){
  const visible = trainingConfig.dates.filter(d=>d.active!==false);
  if(!visible.length){ toast('No visible training days to hide','info'); return; }
  const go = await confirmDialog(`Hide all ${visible.length} visible training day(s) from supervisors? Existing assignments are not affected — you can unhide any day individually afterwards.`);
  if(!go) return;
  trainingConfig = await getShared(K_CONFIG, trainingConfig);
  trainingConfig.dates.forEach(d=>{ d.active = false; });
  const ok = await setConfigWithHistory(trainingConfig);
  if(ok){
    toast('All training days hidden from supervisors','ok');
    buildDaysFilterBar();
    renderDaysTable();
    buildTrainerFilterBar();
    renderCalendar();
  }
}

function openDayStatusModal(dayId){
  const day = trainingConfig.dates.find(d=>d.id===dayId);
  if(!day) return;
  const sups = (day.visibleSupervisors && day.visibleSupervisors.length) ? day.visibleSupervisors : [];
  const rows = sups.map(sup=>{
    const own = masterData.filter(p=>p.supervisor===sup);
    const assignedList = own.filter(p=>ops.assignments[p.id]?.type==='date' && ops.assignments[p.id]?.dateId===dayId);
    const assignedToThisDay = assignedList.length;
    const remainingOverall = own.filter(p=>!ops.assignments[p.id]).length;
    const quota = (day.isOnline && day.supervisorQuotas && day.supervisorQuotas[sup]!==undefined) ? day.supervisorQuotas[sup] : null;
    const hasPendingApproval = assignedList.some(p=>ops.assignments[p.id].overQuota && !ops.assignments[p.id].quotaApproved);
    let statusText, badgeStyle;
    if(assignedToThisDay===0){
      statusText = 'Not started'; badgeStyle = `background:#fff;color:var(--muted);border:1.5px solid var(--border);`;
    } else if(hasPendingApproval){
      statusText = '⚠️ Needs approval'; badgeStyle = `background:var(--danger);color:#fff;border:1.5px solid var(--danger);`;
    } else if(quota!==null && assignedToThisDay>=quota){
      statusText = '✔ Full'; badgeStyle = `background:var(--ok);color:#fff;border:1.5px solid var(--ok);`;
    } else {
      statusText = 'Has room'; badgeStyle = `background:#fff;color:var(--pending);border:1.5px solid var(--pending);`;
    }
    const quotaText = quota!==null ? quota : '∞';
    const remainingQuotaText = quota!==null ? Math.max(quota-assignedToThisDay,0) : '∞';
    return `<tr>
      <td>${esc(sup)}</td>
      <td><span style="display:inline-block;padding:2px 8px;font-size:10px;font-weight:700;border-radius:20px;white-space:nowrap;${badgeStyle}">${statusText}</span></td>
      <td style="text-align:center;">${assignedToThisDay} / ${quotaText}</td>
      <td style="text-align:center;">${remainingQuotaText}</td>
      <td style="text-align:center;${remainingOverall>0?'color:var(--warn);font-weight:700;':''}">${remainingOverall} / ${own.length}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="empty-msg">No supervisors have visibility on this day yet</td></tr>`;

  showModal(`
    <h3>Supervisor Status — ${esc(day.city)}${day.trainingName?' — '+esc(day.trainingName):''} — ${dayDateLabel(day)}</h3>
    <p class="small-note" style="margin-top:-8px;">This day overall: <b>${dayCount(dayId)} / ${dayCapacity(day)}</b> pharmacists assigned.</p>
    <div class="table-wrap"><table style="font-size:11.5px;">
      <thead><tr><th>Supervisor</th><th>Status</th><th>Assigned / Quota</th><th>Quota Left</th><th>Unassigned / Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="modal-actions"><button class="btn btn-outline btn-sm" onclick="closeModal()">Close</button></div>`,
    'max-width:640px;');
}

function buildTrainerFilterBar(){
  document.getElementById('trainerFilterBar').innerHTML =
    `<div class="filter-field search-field"><div class="search-box"><span>🔍</span><input type="text" class="big-search-input" id="trainerSearchInput" value="${esc(trainerSearchQ)}" oninput="onTrainerSearch(this.value)" placeholder="Search name or email..."></div></div>` +
    renderMsFilter('trainer','district','District', distinctValues(masterData,'district').map(v=>({value:v,text:v}))) +
    renderMsFilter('trainer','areaManager','Area Manager', distinctValues(masterData,'areaManager').map(v=>({value:v,text:v}))) +
    renderMsFilter('trainer','city','City', distinctValues(masterData,'city').map(v=>({value:v,text:v}))) +
    renderMsFilter('trainer','supervisor','Supervisor', distinctValues(masterData,'supervisor').map(v=>({value:v,text:v}))) +
    renderMsFilter('trainer','date','Date', dateFilterOptions(trainingConfig.dates.slice().sort((a,b)=>a.date.localeCompare(b.date)))) +
    `<button class="btn btn-outline btn-sm" onclick="clearTrainerFilters()">Clear Filters</button>`;
  renderConductedBySelect();
}
function onTrainerSearch(v){ trainerSearchQ=v; renderTrainerTable(); }
function clearTrainerFilters(){
  trainerFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), date:new Set() };
  trainerSearchQ='';
  buildTrainerFilterBar();
  renderTrainerTable();
}

/** Distinct training-day dates for the "Date" filter, sorted chronologically (ISO strings sort correctly as text) and labelled the same way the table shows them. */
function daysDateFilterOptions(){
  const seen = new Set();
  return trainingConfig.dates
    .map(d=>d.date)
    .filter(v=>{ if(!v || seen.has(v)) return false; seen.add(v); return true; })
    .sort()
    .map(v=>({value:v, text: formatDate(v)}));
}
function buildDaysFilterBar(){
  const bar = document.getElementById('daysFilterBar');
  if(!bar) return;
  bar.innerHTML =
    `<div class="filter-field search-field"><div class="search-box"><span>🔍</span><input type="text" class="big-search-input" id="daysSearchInput" value="${esc(daysSearchQ)}" oninput="onDaysSearch(this.value)" placeholder="Search city, training, trainer..."></div></div>` +
    renderMsFilter('days','city','City', distinctValues(trainingConfig.dates,'city').map(v=>({value:v,text:v}))) +
    renderMsFilter('days','type','Type', TRAINING_DAY_TYPES.map(v=>({value:v,text:v}))) +
    renderMsFilter('days','date','Date', daysDateFilterOptions()) +
    renderMsFilter('days','trainer','Trainer(s)', distinctArrayValues(trainingConfig.dates,'trainerNames').map(v=>({value:v,text:v}))) +
    renderMsFilter('days','visibleTo','Visible To', distinctArrayValues(trainingConfig.dates,'visibleSupervisors').map(v=>({value:v,text:v}))) +
    renderMsFilter('days','status','Status', [{value:'active',text:'Active'},{value:'hidden',text:'Hidden'}]) +
    `<button class="btn btn-outline btn-sm" onclick="clearDaysFilters()">Clear Filters</button>`;
}
function onDaysSearch(v){ daysSearchQ=v; renderDaysTable(); }
function clearDaysFilters(){
  daysFilterState = { city:new Set(), type:new Set(), date:new Set(), trainer:new Set(), visibleTo:new Set(), status:new Set() };
  daysSearchQ='';
  buildDaysFilterBar();
  renderDaysTable();
}
function dayMatchesFilters(d){
  const st = daysFilterState;
  if(st.city.size && !st.city.has((d.city||'').toString())) return false;
  if(st.type.size && !st.type.has(d.type||'Pharmacist Training')) return false;
  if(st.date.size && !st.date.has(d.date)) return false;
  if(st.trainer.size && !(d.trainerNames||[]).some(n=>st.trainer.has(n))) return false;
  if(st.visibleTo.size && !(d.visibleSupervisors||[]).some(n=>st.visibleTo.has(n))) return false;
  if(st.status.size){
    const key = d.active!==false ? 'active' : 'hidden';
    if(!st.status.has(key)) return false;
  }
  if(daysSearchQ){
    const q = daysSearchQ.toLowerCase();
    const hay = [d.city, d.trainingName, d.type, ...(d.trainerNames||[]), ...(d.visibleSupervisors||[])].filter(Boolean).join(' ').toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}

/* ═══════════════════════════════ TRAINER TABLE + ATTENDANCE ═══════════════════════════════ */
function applyTrainerFilters(list){
  return list.filter(p=>{
    if(!inSet(p.district, trainerFilterState.district)) return false;
    if(!inSet(p.areaManager, trainerFilterState.areaManager)) return false;
    if(!inSet(p.city, trainerFilterState.city)) return false;
    if(!inSet(p.supervisor, trainerFilterState.supervisor)) return false;
    if(!matchesDateSet(p.id, trainerFilterState.date)) return false;
    if(trainerSearchQ){
      const q = trainerSearchQ.toLowerCase();
      if(!p.displayName.toLowerCase().includes(q) && !(p.email||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function singleSelectedDate(){
  const set = trainerFilterState.date;
  if(set.size!==1) return null;
  const val = [...set][0];
  return val.startsWith('date:') ? val.split(':')[1] : null;
}

function renderConductedBySelect(){
  const card = document.getElementById('sessionCard');
  if(!card) return;
  const dateId = singleSelectedDate();
  if(!dateId){ card.style.display = 'none'; return; }
  const day = trainingConfig.dates.find(d=>d.id===dateId);
  if(!day){ card.style.display='none'; return; }
  card.style.display = '';
  const assignedTrainerText = (day.trainerNames && day.trainerNames.length) ? ` — Assigned trainer(s): ${day.trainerNames.join(', ')}.` : '';
  const venueText = day.venue ? ` Venue: ${day.venue}.` : '';
  document.getElementById('sessionHint').textContent = `Session: ${day.city} — ${dayDateLabel(day)}.${assignedTrainerText}${venueText}`;
  const zoomBtn = document.getElementById('sessionZoomLink');
  if(zoomBtn){
    if(day.isOnline && day.zoomLink){
      zoomBtn.href = day.zoomLink;
      zoomBtn.classList.remove('hidden');
    } else {
      zoomBtn.classList.add('hidden');
    }
  }
  renderSessionSummary(dateId);
}
function renderSessionSummary(dateId){
  const el = document.getElementById('sessionSummaryChips');
  if(!el) return;
  const assignedList = masterData.filter(p=>ops.assignments[p.id]?.type==='date' && ops.assignments[p.id]?.dateId===dateId);
  const assigned = assignedList.length;
  const attended = assignedList.filter(p=>attSummary(p.id,p).status==='Attended').length;
  const absent = assignedList.filter(p=>attSummary(p.id,p).status==='Absent').length;
  const remaining = assigned - attended - absent;
  const rate = assigned ? Math.round((attended/assigned)*100) : 0;
  el.innerHTML = `
    <div class="chip info"><div class="lbl">Assigned Today</div><div class="num">${assigned}</div></div>
    <div class="chip ok"><div class="lbl">Attended</div><div class="num">${attended}</div></div>
    <div class="chip neutral"><div class="lbl">Not Marked Yet</div><div class="num">${remaining}</div></div>
    <div class="chip danger"><div class="lbl">Absent</div><div class="num">${absent}</div></div>
    <div class="chip ok-outline"><div class="lbl">Attendance So Far</div><div class="num">${rate}%</div></div>`;
}

function attendanceCellHtml(p){
  if(!hasValidDateAssignment(p)) return '—';
  if(isSplitPerson(p)){
    const att = ops.attendance[p.id] || {};
    const d1 = att.day1 || {}, d2 = att.day2 || {};
    const dayBlock = (n, d)=>{
      const locked = n===2 && d1.status!=='Attended';
      return `
      <div class="small-note" style="font-weight:800;margin:0 0 3px;">Day ${n}</div>
      <div class="attend-controls">
        <button class="att-btn attended ${d.status==='Attended'?'active':''}" ${locked?'disabled title="Day 1 must be marked Attended first"':''} onclick="setSplitAttendanceStatus('${p.id}',${n},'Attended')">Attended</button>
        <button class="att-btn absent ${d.status==='Absent'?'active':''}" onclick="setSplitAttendanceStatus('${p.id}',${n},'Absent')">Absent</button>
      </div>
      ${locked ? `<div class="small-note" style="color:var(--danger);margin-top:2px;">Complete Day 1 first (here or via make-up elsewhere)</div>` : ''}
      ${d.status==='Attended' ? `<div class="attend-controls" style="margin-top:3px;">
        <button class="att-btn ontime ${(d.punctuality||'On Time')==='On Time'?'active':''}" onclick="setSplitPunctuality('${p.id}',${n},'On Time')">On Time</button>
        <button class="att-btn late ${d.punctuality==='Late'?'active':''}" onclick="setSplitPunctuality('${p.id}',${n},'Late')">Late</button>
      </div>${d.punctuality==='Late' ? `<input type="time" value="${d.time||''}" style="width:85px;margin-top:3px;" onchange="onSplitAttendanceTimeChange('${p.id}',${n}, this.value)">` : ''}` : ''}`;
    };
    const summary = attSummary(p.id, p);
    let summaryHtml = '';
    if(summary.status==='Attended') summaryHtml = `<span class="badge badge-date">✔ Both days complete</span>`;
    else if(summary.status==='Partial') summaryHtml = `<span class="badge badge-danger">⚠️ Day ${summary.missingDay} still missing — eligible for make-up</span>`;
    else if(summary.status==='Absent') summaryHtml = `<span class="badge badge-danger">Both days absent</span>`;
    return `<div style="display:flex;gap:10px;align-items:flex-start;"><div style="flex:1;min-width:0;">${dayBlock(1,d1)}</div><div style="flex:1;min-width:0;">${dayBlock(2,d2)}</div></div><div style="margin-top:6px;">${summaryHtml}</div>
      ${(d1.status||d2.status) ? `<div style="margin-top:3px;"><button class="att-btn" style="color:var(--muted);" onclick="clearAttendanceStatus('${p.id}')">↺ Clear both</button></div>` : ''}`;
  }
  const att = ops.attendance[p.id];
  const status = att && att.status;
  const punct = (att && att.punctuality) || 'On Time';
  let html = `<div class="attend-controls">
      <button class="att-btn attended ${status==='Attended'?'active':''}" onclick="setAttendanceStatus('${p.id}','Attended')">Attended</button>
      <button class="att-btn absent ${status==='Absent'?'active':''}" onclick="setAttendanceStatus('${p.id}','Absent')">Absent</button>
    </div>`;
  if(status==='Attended'){
    html += `<div class="attend-controls" style="margin-top:3px;">
      <button class="att-btn ontime ${punct==='On Time'?'active':''}" onclick="setPunctuality('${p.id}','On Time')">On Time</button>
      <button class="att-btn late ${punct==='Late'?'active':''}" onclick="setPunctuality('${p.id}','Late')">Late</button>
    </div>`;
  }
  if(status){
    html += `<div style="margin-top:3px;"><button class="att-btn" style="color:var(--muted);" onclick="clearAttendanceStatus('${p.id}')">↺ Clear</button></div>`;
  }
  return html;
}
async function clearAttendanceStatus(pid){
  if(!requireTrainerIdentity()) return;
  if(ops.attendance[pid]){
    delete ops.attendance[pid].status;
    delete ops.attendance[pid].punctuality;
    delete ops.attendance[pid].time;
    delete ops.attendance[pid].day1;
    delete ops.attendance[pid].day2;
  }
  const ok = await setShared(K_OPS, ops);
  if(ok){ toast('Attendance cleared','ok'); afterTrainerRowChange(pid); }
}
async function setSplitAttendanceStatus(pid, dayNum, status){
  if(!requireTrainerIdentity()) return;
  const prev = ops.attendance[pid] || {};
  if(dayNum===2 && status==='Attended' && (!prev.day1 || prev.day1.status!=='Attended')){
    toast(`Can't mark Day 2 as Attended — Day 1 hasn't been completed yet. Have them make up Day 1 in another group first.`,'err');
    return;
  }
  const key = 'day'+dayNum;
  let sub = {...(prev[key]||{}), status, markedBy: currentTrainerIdentity, markedAt: nowIso()};
  if(status==='Attended'){
    if(!sub.punctuality) sub.punctuality = 'On Time';
    if(sub.punctuality==='On Time') sub.time = '';
  } else {
    delete sub.punctuality;
    sub.time = '';
  }
  const updated = {...prev, [key]: sub};
  if(dayNum===1 && status==='Absent'){
    // Absent on Day 1 automatically makes Day 2 Absent too — can't attend Day 2 without Day 1.
    updated.day2 = {status:'Absent', markedBy: currentTrainerIdentity, markedAt: nowIso()};
  }
  ops.attendance[pid] = updated;
  const ok = await setShared(K_OPS, ops);
  if(ok){ toast(dayNum===1 && status==='Absent' ? 'Day 1 recorded — Day 2 auto-marked Absent' : `Day ${dayNum} recorded`,'ok'); afterTrainerRowChange(pid); }
}
async function setSplitPunctuality(pid, dayNum, punct){
  if(!requireTrainerIdentity()) return;
  const prev = ops.attendance[pid] || {};
  const key = 'day'+dayNum;
  const prevSub = prev[key] || {status:'Attended'};
  let time = prevSub.time;
  if(punct==='Late' && !time) time = nowTimeStr();
  if(punct==='On Time') time = '';
  ops.attendance[pid] = {...prev, [key]: {...prevSub, punctuality: punct, time, markedBy: currentTrainerIdentity, markedAt: nowIso()}};
  const ok = await setShared(K_OPS, ops);
  if(ok){ toast('Updated','ok'); afterTrainerRowChange(pid); }
}
function arrivalCellHtml(p){
  if(!hasValidDateAssignment(p)) return '—';
  if(isSplitPerson(p)) return '<span class="small-note">See Day 1/2 above</span>';
  const att = ops.attendance[p.id];
  if(!att || att.status!=='Attended' || (att.punctuality||'On Time')!=='Late') return '—';
  return `<input type="time" value="${att.time||''}" style="width:85px" onchange="onAttendanceTimeChange('${p.id}', this.value)">`;
}
// The note is the pharmacist's "Notes" cell in the HeadCount tab: what the trainer types here is written to the sheet,
// and anything typed in the sheet shows here — and to the pharmacist's supervisor on the supervisor page.
function noteCellHtml(p){
  const att = ops.attendance[p.id];
  const note = (p.note!==undefined && p.note!=='') ? p.note : (att && att.note ? att.note : '');
  return `<input type="text" class="note-input" placeholder="Notes" value="${esc(note)}" onchange="onPharmacistNoteChange('${p.id}', this.value)">`;
}

// The cells of one trainer-table row. Single source of truth shared by the full render and the single-row
// update below, so a row refreshed on its own always matches a full redraw.
// Column order: Pharmacist Name (with row number), Email, Supervisor, District, Area Manager, City, Date, …
function trainerRowCells(p, rownum){
  const days = trainingConfig.dates;
  return `
      <td class="name-cell"><span class="rownum">${rownum}</span>${esc(p.displayName)}</td>
      <td>${esc(p.email||'—')}</td>
      <td>${esc(p.supervisor)}</td>
      <td>${esc(p.district||'—')}</td>
      <td>${esc(p.areaManager||'—')}</td>
      <td>${cityCellHtml(p)}</td>
      <td class="no-truncate">${dateCellHtml(p, true, days, 'onTrainerAssignChange')}</td>
      <td>${completionCellHtml(p)}</td>
      <td class="no-truncate">${attendanceCellHtml(p)}</td>
      <td>${arrivalCellHtml(p)}</td>
      <td>${noteCellHtml(p)}</td>`;
}

function renderTrainerTable(){
  document.getElementById('trainerTableTitle').textContent = trainerFilterState.date.size ? 'Filtered Records' : 'All Records';

  let list = applyTrainerFilters(masterData);
  list = applySort('trainer', list);
  const tb = document.getElementById('trainerTableBody');
  const dateId = singleSelectedDate();
  if(dateId) renderSessionSummary(dateId);
  if(!list.length){
    tb.innerHTML = `<tr><td colspan="11" class="empty-msg">No records match the current filters</td></tr>`;
    updateSortIndicators('trainer');
    return;
  }
  tb.innerHTML = list.map((p,i)=>`<tr id="trrow_${p.id}">${trainerRowCells(p, i+1)}</tr>`).join('');
  updateSortIndicators('trainer');
}

// Refreshes just the one row that changed instead of redrawing all ~1,450. Falls back to a full render if the
// row isn't on screen (e.g. filtered out).
function updateTrainerRow(pid){
  const tr = document.getElementById('trrow_'+pid);
  const p = masterData.find(m=>m.id===pid);
  if(!tr || !p){ renderTrainerTable(); return; }
  const numEl = tr.querySelector('.rownum');
  tr.innerHTML = trainerRowCells(p, numEl ? numEl.textContent : '');
}

// After an attendance change (which never changes which rows match the filters), update only that row.
// A change can reorder the table only when it's sorted by the Attendance column, so fall back to a full
// render in that one case to keep ordering identical to before.
function afterTrainerRowChange(pid){
  if(sortState.trainer.key === 'attendance'){ renderTrainerTable(); return; }
  updateTrainerRow(pid);
  const dateId = singleSelectedDate();
  if(dateId) renderSessionSummary(dateId);
}

async function onTrainerAssignChange(pid, value){
  if(!value){
    delete ops.assignments[pid];
    delete ops.attendance[pid];
  } else {
    const [type, rest] = value.split(':');
    if(type==='date'){
      if(isDayFull(rest, pid)){
        const capD = dayById(rest);
        const go = await confirmDialog(`This day is at full capacity (${dayCapacity(capD)}). As a trainer, you can still add this pharmacist over capacity — continue?`);
        if(!go){ renderTrainerTable(); return; }
      }
      const prevAssignment = ops.assignments[pid];
      if(!prevAssignment || prevAssignment.type!=='date' || prevAssignment.dateId!==rest){
        delete ops.attendance[pid];
      }
      ops.assignments[pid] = {type:'date', dateId:rest, assignedBy:'Trainer'+(currentTrainerIdentity?' ('+currentTrainerIdentity+')':''), assignedAt: nowIso()};
    } else {
      ops.assignments[pid] = {type:'leave', status:rest, assignedBy:'Trainer'+(currentTrainerIdentity?' ('+currentTrainerIdentity+')':''), assignedAt: nowIso()};
      delete ops.attendance[pid];
    }
  }
  const ok = await setShared(K_OPS, ops);
  if(ok){ toast('Saved','ok'); renderTrainerTable(); }
}

function requireTrainerIdentity(){
  return true;
}

async function setAttendanceStatus(pid, status){
  if(!requireTrainerIdentity()) return;
  const prev = ops.attendance[pid] || {};
  let record = {...prev, status, markedBy: currentTrainerIdentity, markedAt: nowIso()};
  if(status==='Attended'){
    if(!record.punctuality) record.punctuality = 'On Time';
    if(record.punctuality==='On Time') record.time = '';
  } else {
    delete record.punctuality;
    record.time = '';
  }
  ops.attendance[pid] = record;
  const ok = await setShared(K_OPS, ops);
  if(ok){ toast('Attendance recorded','ok'); afterTrainerRowChange(pid); }
}
async function setPunctuality(pid, punct){
  if(!requireTrainerIdentity()) return;
  const prev = ops.attendance[pid] || {status:'Attended'};
  let time = prev.time;
  if(punct==='Late' && !time) time = nowTimeStr();
  if(punct==='On Time') time = '';
  ops.attendance[pid] = {...prev, punctuality: punct, time, markedBy: currentTrainerIdentity, markedAt: nowIso()};
  const ok = await setShared(K_OPS, ops);
  if(ok){ toast('Updated','ok'); afterTrainerRowChange(pid); }
}
async function onAttendanceTimeChange(pid, time){
  if(!requireTrainerIdentity()) return;
  const prev = ops.attendance[pid] || {status:'Attended', punctuality:'Late'};
  ops.attendance[pid] = {...prev, time, markedBy: currentTrainerIdentity, markedAt: nowIso()};
  const ok = await setShared(K_OPS, ops);
  if(ok) toast('Arrival time updated','ok');
}
async function onSplitAttendanceTimeChange(pid, dayNum, time){
  if(!requireTrainerIdentity()) return;
  const prev = ops.attendance[pid] || {};
  const key = 'day'+dayNum;
  const prevSub = prev[key] || {status:'Attended', punctuality:'Late'};
  ops.attendance[pid] = {...prev, [key]: {...prevSub, time, markedBy: currentTrainerIdentity, markedAt: nowIso()}};
  const ok = await setShared(K_OPS, ops);
  if(ok) toast('Arrival time updated','ok');
}
async function onPharmacistNoteChange(pid, note){
  const p = masterData.find(m=>m.id===pid);
  if(!p) return;
  p.note = String(note||'').trim();
  const ok = await setShared(K_MASTER, masterData);
  if(ok) toast('Note saved — the pharmacist\'s supervisor can see it','ok');
}

async function refreshTrainer(){
  await loadCoreData();
  buildTrainerFilterBar();
  renderTrainerTable();
  updatePendingDot();
  toast('Refreshed','ok');
}

/* ═══════════════════════════════ APPROVALS ═══════════════════════════════ */
// `leaveRequests`, when passed, is a freshly-loaded list the caller already has — avoids fetching it again just for the dot count.
async function updatePendingDot(leaveRequests){
  const n = pendingList.filter(p=>p.status==='Pending').length;
  const quotaCount = Object.values(ops.assignments||{}).filter(a=>a.type==='date' && a.overQuota && !a.quotaApproved).length;
  const lr = leaveRequests || await getShared(K_LEAVE_REQUESTS, []);
  const leaveCount = lr.filter(x=>x.status==='Pending').length;
  const total = n + quotaCount + leaveCount;
  const dot = document.getElementById('pendingDot');
  if(dot) dot.innerHTML = total>0 ? `<span class="dot-badge">${total}</span>` : '';
}

let apprSortState = {key:null, dir:1};
function toggleApprovalsSort(key){
  if(apprSortState.key===key) apprSortState.dir*=-1; else { apprSortState.key=key; apprSortState.dir=1; }
  renderApprovalsTab();
}
let apprHistSortState = {key:null, dir:1};
function toggleApprHistSort(key){
  if(apprHistSortState.key===key) apprHistSortState.dir*=-1; else { apprHistSortState.key=key; apprHistSortState.dir=1; }
  renderApprovalsHistory();
}
function genericSort(list, state, valueFn){
  if(!state.key) return list;
  return [...list].sort((a,b)=>{
    const va = valueFn(a, state.key), vb = valueFn(b, state.key);
    if(va<vb) return -1*state.dir;
    if(va>vb) return 1*state.dir;
    return 0;
  });
}
function updateSortIndicatorsGeneric(prefix, state){
  document.querySelectorAll(`[id^="sort-${prefix}-"]`).forEach(el=>{
    const key = el.id.replace(`sort-${prefix}-`,'');
    el.textContent = state.key===key ? (state.dir===1?'▲':'▼') : '';
  });
}

function renderQuotaApprovals(){
  const tb = document.getElementById('quotaApprovalsBody');
  if(!tb) return;
  const items = [];
  Object.entries(ops.assignments||{}).forEach(([pid,a])=>{
    if(a.type==='date' && a.overQuota && !a.quotaApproved){
      const p = masterData.find(m=>m.id===pid);
      const day = trainingConfig.dates.find(d=>d.id===a.dateId);
      if(p && day) items.push({pid, p, day});
    }
  });
  if(!items.length){
    tb.innerHTML = `<tr><td colspan="5" class="empty-msg">No over-quota assignments waiting</td></tr>`;
    return;
  }
  tb.innerHTML = items.map((it,i)=>`
    <tr>
      <td class="name-cell"><span class="rownum">${i+1}</span>${esc(it.p.displayName)}</td>
      <td>${esc(it.p.email||'—')}</td>
      <td>${esc(it.p.supervisor)}</td>
      <td>${esc(it.day.city)} — ${formatDate(it.day.date)}</td>
      <td>
        <button class="btn btn-ok btn-sm" onclick="approveQuota('${it.pid}')">✔ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="rejectQuota('${it.pid}')">✕ Reject</button>
      </td>
    </tr>`).join('');
}
async function approveQuota(pid){
  ops = await getShared(K_OPS, {assignments:{}, attendance:{}});
  if(ops.assignments[pid]){ ops.assignments[pid].quotaApproved = true; }
  const ok = await setShared(K_OPS, ops);
  if(ok){
    const p = masterData.find(m=>m.id===pid);
    if(p){
      await pushNotification(p.supervisor, `${p.displayName} — Over-Quota Assignment`, 'Approved');
      await pushQuotaHistory(p.supervisor, p.displayName, 'Approved');
    }
    toast('Approved','ok'); renderQuotaApprovals(); renderTrainerTable();
  }
}
function rejectQuota(pid){
  const p = masterData.find(m=>m.id===pid);
  showModal(`
    <h3>Reject Over-Quota Assignment</h3>
    <p class="small-note">Rejecting${p?' <b>'+esc(p.displayName)+'</b>':''}'s over-quota assignment. They'll go back to Not Assigned. This stays in the supervisor's notification and Submission History so they can see why.</p>
    <div class="field"><label class="field-label">Reason for rejection (optional)</label><textarea id="rejectQuotaReasonInput" rows="3"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger btn-sm" onclick="confirmRejectQuota('${pid}')">Reject</button>
    </div>`);
}
async function confirmRejectQuota(pid){
  const reason = document.getElementById('rejectQuotaReasonInput').value.trim();
  closeModal();
  ops = await getShared(K_OPS, {assignments:{}, attendance:{}});
  const p = masterData.find(m=>m.id===pid);
  delete ops.assignments[pid];
  const ok = await setShared(K_OPS, ops);
  if(ok){
    if(p){
      await pushNotification(p.supervisor, `${p.displayName} — Over-Quota Assignment`, 'Rejected', reason);
      await pushQuotaHistory(p.supervisor, p.displayName, 'Rejected', reason);
    }
    toast('Rejected','ok'); renderQuotaApprovals(); renderTrainerTable();
  }
}

async function renderLeaveRequests(){
  leaveRequestsCache = await getShared(K_LEAVE_REQUESTS, []);
  const tb = document.getElementById('leaveRequestsBody');
  if(!tb) return;
  const list = leaveRequestsCache.filter(lr=>lr.status==='Pending');
  if(!list.length){
    tb.innerHTML = `<tr><td colspan="5" class="empty-msg">No Annual Leave requests waiting</td></tr>`;
    return;
  }
  tb.innerHTML = list.map((lr,i)=>`
    <tr>
      <td class="name-cell"><span class="rownum">${i+1}</span>${esc(lr.displayName)}</td>
      <td>${esc(((masterData.find(m=>m.id===lr.pharmacistId))||{}).email||'—')}</td>
      <td>${esc(lr.supervisor)}</td>
      <td>${new Date(lr.requestedAt).toLocaleDateString('en-GB')}</td>
      <td>
        <button class="btn btn-ok btn-sm" onclick="approveLeaveRequest('${lr.id}')">✔ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="rejectLeaveRequest('${lr.id}')">✕ Reject</button>
      </td>
    </tr>`).join('');
}
async function approveLeaveRequest(lrId){
  leaveRequestsCache = await getShared(K_LEAVE_REQUESTS, []);
  const lr = leaveRequestsCache.find(x=>x.id===lrId);
  if(!lr) return;
  ops = await getShared(K_OPS, {assignments:{}, attendance:{}});
  ops.assignments[lr.pharmacistId] = {type:'leave', status:'Annual Leave', assignedBy:lr.supervisor, assignedAt: nowIso()};
  const ok1 = await setShared(K_OPS, ops);
  lr.status = 'Approved';
  lr.decidedAt = nowIso();
  const ok2 = await setShared(K_LEAVE_REQUESTS, leaveRequestsCache);
  if(ok1 && ok2){
    await pushNotification(lr.supervisor, `${lr.displayName} — Annual Leave Request`, 'Approved');
    toast('Approved — status set to Annual Leave','ok'); renderLeaveRequests(); renderTrainerTable();
  }
}
function rejectLeaveRequest(lrId){
  const lr = leaveRequestsCache.find(x=>x.id===lrId);
  showModal(`
    <h3>Reject Annual Leave Request</h3>
    <p class="small-note">Rejecting${lr?' <b>'+esc(lr.displayName)+'</b>':''}'s Annual Leave request. This stays in the supervisor's notification so they can see why.</p>
    <div class="field"><label class="field-label">Reason for rejection (optional)</label><textarea id="rejectLeaveReasonInput" rows="3"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger btn-sm" onclick="confirmRejectLeaveRequest('${lrId}')">Reject</button>
    </div>`);
}
async function confirmRejectLeaveRequest(lrId){
  const reason = document.getElementById('rejectLeaveReasonInput').value.trim();
  closeModal();
  leaveRequestsCache = await getShared(K_LEAVE_REQUESTS, []);
  const lr = leaveRequestsCache.find(x=>x.id===lrId);
  if(lr){ lr.status = 'Rejected'; lr.decidedAt = nowIso(); lr.rejectionReason = reason; }
  const ok = await setShared(K_LEAVE_REQUESTS, leaveRequestsCache);
  if(ok){
    if(lr) await pushNotification(lr.supervisor, `${lr.displayName} — Annual Leave Request`, 'Rejected', reason);
    toast('Rejected','ok'); renderLeaveRequests();
  }
}

async function renderApprovalsTab(){
  renderQuotaApprovals();
  await renderLeaveRequests();
  let list = pendingList.filter(p=>p.status==='Pending');
  list = genericSort(list, apprSortState, (p,k)=> k==='addedAt' ? p.addedAt : String(p[k]||'').toLowerCase());
  const tb = document.getElementById('approvalsTableBody');
  if(!list.length){
    tb.innerHTML = `<tr><td colspan="12" class="empty-msg">No pharmacists awaiting approval</td></tr>`;
  } else {
    tb.innerHTML = list.map((p,i)=>`
      <tr>
        <td class="name-cell"><span class="rownum">${i+1}</span><input type="text" value="${esc(p.displayName)}" id="ap-name-${p.id}" style="width:170px"></td>
        <td><input type="text" value="${esc(p.email)}" id="ap-email-${p.id}" style="width:170px"></td>
        <td>${esc(p.supervisor)}</td>
        <td>${esc(p.district||'—')}</td>
        <td>${esc(p.areaManager||'—')}</td>
        <td>${cityCellHtml(p)}</td>
        <td><input type="text" value="${esc(p.pharmacyNo)}" id="ap-pn-${p.id}" style="width:80px"></td>
        <td><input type="text" value="${esc(p.employeeId)}" id="ap-eid-${p.id}" style="width:80px"></td>
        <td><input type="text" value="${esc(p.phone)}" id="ap-phone-${p.id}" style="width:100px"></td>
        <td><input type="text" value="${esc(p.scfhs)}" id="ap-scfhs-${p.id}" style="width:80px"></td>
        <td>${new Date(p.addedAt).toLocaleDateString('en-GB')}</td>
        <td class="no-truncate">
          <button class="btn btn-ok btn-sm" onclick="approvePharmacist('${p.id}')">✔ Approve</button>
          <button class="btn btn-danger btn-sm" onclick="rejectPharmacist('${p.id}')">✕ Reject</button>
        </td>
      </tr>`).join('');
  }
  updateSortIndicatorsGeneric('appr', apprSortState);
  renderApprovalsHistory();
}

function renderApprovalsHistory(){
  const tb = document.getElementById('approvalsHistoryBody');
  if(!tb) return;
  let list = pendingList.filter(p=>p.status==='Approved' || p.status==='Rejected');
  if(apprHistSortState.key){
    list = genericSort(list, apprHistSortState, (p,k)=> k==='decidedAt' ? (p.decidedAt||'') : String(p[k]||'').toLowerCase());
  } else {
    list = [...list].sort((a,b)=> new Date(b.decidedAt||0) - new Date(a.decidedAt||0));
  }
  if(!list.length){
    tb.innerHTML = `<tr><td colspan="7" class="empty-msg">No decisions made yet</td></tr>`;
    updateSortIndicatorsGeneric('apprhist', apprHistSortState);
    return;
  }
  tb.innerHTML = list.map((p,i)=>`
    <tr>
      <td class="name-cell"><span class="rownum">${i+1}</span>${esc(p.displayName)}</td>
      <td>${esc(p.email||'—')}</td>
      <td>${esc(p.supervisor)}</td>
      <td><span class="badge ${p.status==='Approved'?'badge-date':'badge-leave'}">${esc(p.status)}</span></td>
      <td>${esc(p.rejectionReason||'—')}</td>
      <td>${p.decidedAt ? new Date(p.decidedAt).toLocaleDateString('en-GB') : '—'}</td>
      <td class="no-truncate"><button class="btn btn-outline btn-sm" onclick="reopenPharmacist('${p.id}')">↺ Reopen</button> <button class="btn btn-danger btn-sm" onclick="deleteApprovalHistoryEntry('${p.id}')">🗑 Delete</button></td>
    </tr>`).join('');
  updateSortIndicatorsGeneric('apprhist', apprHistSortState);
}

async function pushNotification(supervisor, pharmacistName, result, reason){
  let notifs = await getShared(K_NOTIF, []);
  notifs.push({id:uid('ntf'), supervisor, pharmacistName, result, reason:reason||'', decidedAt: nowIso(), read:false, seenInHistory:false});
  if(notifs.length>300) notifs = notifs.slice(-300);
  await setShared(K_NOTIF, notifs);
}
async function pushQuotaHistory(supervisor, displayName, status, reason){
  let hist = await getShared(K_QUOTA_HISTORY, []);
  hist.push({id:uid('qh'), supervisor, displayName, status, rejectionReason: reason||'', decidedAt: nowIso()});
  if(hist.length>500) hist = hist.slice(-500);
  await setShared(K_QUOTA_HISTORY, hist);
}

async function approvePharmacist(pid){
  const p = pendingList.find(x=>x.id===pid);
  if(!p) return;
  const displayName = document.getElementById('ap-name-'+pid).value.trim();
  const pharmacyNo = document.getElementById('ap-pn-'+pid).value.trim();
  const employeeId = document.getElementById('ap-eid-'+pid).value.trim();
  const email = document.getElementById('ap-email-'+pid).value.trim();
  const phone = document.getElementById('ap-phone-'+pid).value.trim();
  const scfhs = document.getElementById('ap-scfhs-'+pid).value.trim();
  if(!displayName){ toast('Display name is required','err'); return; }

  masterData = await getShared(K_MASTER, []);
  if(!masterData.find(m=>m.id===pid)){
    masterData.push({
      id: pid, district:p.district, areaManager:p.areaManager, city:p.city, supervisor:p.supervisor,
      pharmacyNo, employeeId, email, displayName, phone, scfhs
    });
  }
  const ok1 = await setShared(K_MASTER, masterData);

  pendingList = await getShared(K_PENDING, []);
  const item = pendingList.find(x=>x.id===pid);
  if(item){
    item.status = 'Approved';
    item.decidedAt = nowIso();
    item.rejectionReason = '';
    item.displayName = displayName; item.pharmacyNo = pharmacyNo; item.employeeId = employeeId;
    item.email = email; item.phone = phone; item.scfhs = scfhs;
  }
  const ok2 = await setShared(K_PENDING, pendingList);

  if(ok1 && ok2){
    await pushNotification(p.supervisor, displayName, 'Approved');
    toast('Approved and added to the master sheet','ok');
    await renderApprovalsTab();
    renderMasterPreview();
    updatePendingDot(leaveRequestsCache);
  }
}
function rejectPharmacist(pid){
  const p = pendingList.find(x=>x.id===pid);
  if(!p) return;
  showModal(`
    <h3>Reject Pharmacist</h3>
    <p class="small-note">Rejecting <b>${esc(p.displayName)}</b>. This stays in the history so the supervisor can see why.</p>
    <div class="field"><label class="field-label">Reason for rejection (optional)</label><textarea id="rejectReasonInput" rows="3"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger btn-sm" onclick="confirmRejectPharmacist('${pid}')">Reject</button>
    </div>`);
}
async function confirmRejectPharmacist(pid){
  const reason = document.getElementById('rejectReasonInput').value.trim();
  pendingList = await getShared(K_PENDING, []);
  const item = pendingList.find(x=>x.id===pid);
  if(item){
    item.status = 'Rejected';
    item.rejectionReason = reason;
    item.decidedAt = nowIso();
  }
  const ok = await setShared(K_PENDING, pendingList);
  closeModal();
  if(ok){
    if(item) await pushNotification(item.supervisor, item.displayName, 'Rejected', reason);
    toast('Rejected','ok');
    await renderApprovalsTab();
    updatePendingDot(leaveRequestsCache);
  }
}
async function reopenPharmacist(pid){
  const go = await confirmDialog('Reopen this entry for reconsideration? If it was previously approved, it will be removed from the master sheet until decided again.');
  if(!go) return;
  pendingList = await getShared(K_PENDING, []);
  const item = pendingList.find(x=>x.id===pid);
  if(!item) return;
  const wasApproved = item.status==='Approved';
  item.status = 'Pending';
  item.rejectionReason = '';
  item.decidedAt = null;
  const ok1 = await setShared(K_PENDING, pendingList);

  let ok2 = true;
  if(wasApproved){
    masterData = await getShared(K_MASTER, []);
    masterData = masterData.filter(m=>m.id!==pid);
    ok2 = await setShared(K_MASTER, masterData);
  }
  if(ok1 && ok2){
    toast('Reopened — back in the Pending queue','ok');
    await renderApprovalsTab();
    renderMasterPreview();
    updatePendingDot(leaveRequestsCache);
  }
}

async function deleteApprovalHistoryEntry(pid){
  const go = await confirmDialog('Delete this history entry? This only removes the log record — it does not undo the approval/rejection itself.');
  if(!go) return;
  pendingList = await getShared(K_PENDING, []);
  pendingList = pendingList.filter(x=>x.id!==pid);
  const ok = await setShared(K_PENDING, pendingList);
  if(ok){ toast('Deleted','ok'); renderApprovalsHistory(); }
}
async function clearAllApprovalsHistory(){
  pendingList = await getShared(K_PENDING, []);
  const historyCount = pendingList.filter(p=>p.status==='Approved' || p.status==='Rejected').length;
  if(!historyCount){ toast('No history to clear','info'); return; }
  const go = await confirmDialog(`Delete all ${historyCount} decision history record(s)? This only removes the log — it does not undo any approvals or rejections.`);
  if(!go) return;
  pendingList = pendingList.filter(p=>p.status==='Pending');
  const ok = await setShared(K_PENDING, pendingList);
  if(ok){ toast('Decision history cleared','ok'); renderApprovalsHistory(); }
}

/* ═══════════════════════════════ ANALYTICS ═══════════════════════════════ */
let analyticsDim = 'city';
function toggleBreakdown(){
  const body = document.getElementById('breakdownBody');
  const chevron = document.getElementById('breakdownChevron');
  const expanded = body.classList.contains('hidden');
  body.classList.toggle('hidden', !expanded);
  chevron.textContent = expanded ? '▾' : '▸';
}
function setAnalyticsDim(dim){
  analyticsDim = dim;
  document.querySelectorAll('#dimToggle button').forEach(b=>b.classList.toggle('active', b.dataset.dim===dim));
  const labels = {city:'City', district:'District', areaManager:'Area Manager', supervisor:'Supervisor'};
  document.getElementById('dimHeader').textContent = labels[dim];
  renderAnalyticsTable();
}
async function refreshAnalytics(){
  await loadCoreData();
  renderGlobalChips();
  renderAnalyticsTable();
  buildMasterFilterBar();
  renderMasterSheetPreview();
}
function renderGlobalChips(){
  const total = masterData.length;
  const onTime = masterData.filter(p=>attSummary(p.id,p).status==='Attended' && (attSummary(p.id,p).punctuality||'On Time')==='On Time').length;
  const late = masterData.filter(p=>attSummary(p.id,p).status==='Attended' && attSummary(p.id,p).punctuality==='Late').length;
  const attended = onTime + late;
  const notAssigned = masterData.filter(p=>!ops.assignments[p.id]).length;
  const absentAfterAssign = masterData.filter(p=>ops.assignments[p.id]?.type==='date' && attSummary(p.id,p).status==='Absent').length;
  const pendCount = pendingList.filter(p=>p.status==='Pending').length;
  const pct = n => total ? Math.round((n/total)*100)+'% of total' : '—';

  document.getElementById('globalChipsBig').innerHTML = `
    <div class="chip chip-lg chip-status ok"><div class="lbl">Attended</div><div class="num">${attended}</div><div class="tag">${onTime} On Time · ${late} Late</div></div>
    <div class="chip chip-lg chip-status neutral"><div class="lbl">Not Assigned</div><div class="num">${notAssigned}</div><div class="tag">${pct(notAssigned)}</div></div>
    <div class="chip chip-lg chip-status danger"><div class="lbl">Assigned but Absent</div><div class="num">${absentAfterAssign}</div><div class="tag">${pct(absentAfterAssign)}</div></div>`;

  let smallHtml = `<div class="chip neutral"><div class="lbl">Total Pharmacists</div><div class="num">${total}</div></div>`;
  LEAVE_STATUSES.forEach(s=>{
    const count = masterData.filter(p=>ops.assignments[p.id]?.type==='leave' && ops.assignments[p.id]?.status===s).length;
    smallHtml += `<div class="chip neutral"><div class="lbl">${s}</div><div class="num">${count}</div></div>`;
  });
  smallHtml += `<div class="chip pending"><div class="lbl">Pending Approval</div><div class="num">${pendCount}</div></div>`;
  document.getElementById('globalChipsSmall').innerHTML = smallHtml;
}
let analyticsShowPct = false;
function toggleAnalyticsPct(){
  analyticsShowPct = !analyticsShowPct;
  document.getElementById('pctToggleBtn').textContent = analyticsShowPct ? 'Show as Numbers' : 'Show as %';
  document.getElementById('pctToggleBtn').classList.toggle('active', analyticsShowPct);
  renderAnalyticsTable();
}
function renderAnalyticsTable(){
  const groups = {};
  masterData.forEach(p=>{
    const key = p[analyticsDim] || '—';
    if(!groups[key]) groups[key] = [];
    groups[key].push(p);
  });
  const tb = document.getElementById('analyticsBody');
  const keys = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
  if(!keys.length){ tb.innerHTML = `<tr><td colspan="10" class="empty-msg">No data yet</td></tr>`; return; }
  const cell = (n, total) => analyticsShowPct ? (total ? Math.round((n/total)*100)+'%' : '0%') : n;
  tb.innerHTML = keys.map((key,i)=>{
    const list = groups[key];
    const total = list.length;
    const onTime = list.filter(p=>attSummary(p.id,p).status==='Attended' && (attSummary(p.id,p).punctuality||'On Time')==='On Time').length;
    const late = list.filter(p=>attSummary(p.id,p).status==='Attended' && attSummary(p.id,p).punctuality==='Late').length;
    const attended = onTime + late;
    const notAssigned = list.filter(p=>!ops.assignments[p.id]).length;
    const absentAfterAssign = list.filter(p=>ops.assignments[p.id]?.type==='date' && attSummary(p.id,p).status==='Absent').length;
    const sick = list.filter(p=>ops.assignments[p.id]?.type==='leave' && ops.assignments[p.id]?.status==='Sick Leave').length;
    const annual = list.filter(p=>ops.assignments[p.id]?.type==='leave' && ops.assignments[p.id]?.status==='Annual Leave').length;
    const resign = list.filter(p=>ops.assignments[p.id]?.type==='leave' && ops.assignments[p.id]?.status==='Resignation').length;
    const promo = list.filter(p=>ops.assignments[p.id]?.type==='leave' && ops.assignments[p.id]?.status==='Promotion').length;
    return `<tr>
      <td>${i+1}</td><td>${esc(key)}</td><td>${total}</td>
      <td>${cell(attended,total)}<span class="cell-pct">${onTime} On Time · ${late} Late</span></td>
      <td>${notAssigned>0?'<b style="color:var(--warn)">'+cell(notAssigned,total)+'</b>':cell(notAssigned,total)}</td>
      <td>${absentAfterAssign>0?'<b style="color:var(--danger)">'+cell(absentAfterAssign,total)+'</b>':cell(absentAfterAssign,total)}</td>
      <td>${cell(sick,total)}</td>
      <td>${cell(annual,total)}</td>
      <td>${cell(resign,total)}</td>
      <td>${cell(promo,total)}</td>
    </tr>`;
  }).join('');
}

function buildMasterFilterBar(){
  const el = document.getElementById('masterFilterBar');
  if(!el) return;
  el.innerHTML =
    `<div class="filter-field search-field"><div class="search-box"><span>🔍</span><input type="text" class="big-search-input" id="masterSearchInput" value="${esc(masterSearchQ)}" oninput="onMasterSearch(this.value)" placeholder="Search name or email..."></div></div>` +
    renderMsFilter('master','district','District', distinctValues(masterData,'district').map(v=>({value:v,text:v}))) +
    renderMsFilter('master','areaManager','Area Manager', distinctValues(masterData,'areaManager').map(v=>({value:v,text:v}))) +
    renderMsFilter('master','city','City', distinctValues(masterData,'city').map(v=>({value:v,text:v}))) +
    renderMsFilter('master','supervisor','Supervisor', distinctValues(masterData,'supervisor').map(v=>({value:v,text:v}))) +
    renderMsFilter('master','date','Date', dateFilterOptions(trainingConfig.dates.slice().sort((a,b)=>a.date.localeCompare(b.date)))) +
    `<button class="btn btn-outline btn-sm" onclick="clearMasterFilters()">Clear Filters</button>`;
}
function onMasterSearch(v){ masterSearchQ=v; renderMasterSheetPreview(); }
function clearMasterFilters(){
  masterFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), date:new Set() };
  masterSearchQ='';
  buildMasterFilterBar();
  renderMasterSheetPreview();
}
function applyMasterFilters(list){
  return list.filter(p=>{
    if(!inSet(p.district, masterFilterState.district)) return false;
    if(!inSet(p.areaManager, masterFilterState.areaManager)) return false;
    if(!inSet(p.city, masterFilterState.city)) return false;
    if(!inSet(p.supervisor, masterFilterState.supervisor)) return false;
    if(!matchesDateSet(p.id, masterFilterState.date)) return false;
    if(masterSearchQ){
      const q = masterSearchQ.toLowerCase();
      if(!p.displayName.toLowerCase().includes(q) && !(p.email||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function renderMasterSheetPreview(){
  const tb = document.getElementById('masterSheetPreviewBody');
  if(!tb) return;
  let list = applyMasterFilters(masterData);
  list = applySort('master', list);
  if(!list.length){
    tb.innerHTML = `<tr><td colspan="9" class="empty-msg">No data matches the current filters</td></tr>`;
    updateSortIndicators('master');
    return;
  }
  tb.innerHTML = list.map((p,i)=>{
    const r = buildMasterRow(p);
    return `<tr>
      <td class="name-cell"><span class="rownum">${i+1}</span>${esc(r.displayName)}</td>
      <td>${esc(r.email||'—')}</td>
      <td>${esc(r.supervisor)}</td><td>${esc(r.district||'—')}</td><td>${esc(r.areaManager||'—')}</td><td>${cityCellHtml(p)}</td>
      <td>${esc(r.dateText)}</td>
      <td>${esc(r.statusText)}</td><td>${esc(r.note||'—')}</td>
    </tr>`;
  }).join('');
  updateSortIndicators('master');
}

async function exportMasterSheet(){
  const list = applyMasterFilters(masterData);
  if(!list.length){ toast('No data to export','err'); return; }
  const headers = ['Display Name (Pharmacist name)','Username (Email)','Supervisor Name','District','Area Manager','City','Date','Pharmacy No.','User/Employee ID','Phone number (Whatsapp)','SCFHS','Attendance Status','Notes'];
  const rows = [];
  list.forEach(p=>{
    const r = buildMasterRow(p);
    rows.push([r.displayName,r.email,r.supervisor,r.district,r.areaManager,r.city,r.dateText,r.pharmacyNo,r.employeeId,r.phone,r.scfhs,r.statusText,r.note]);
  });
  const colWidths = computeAutoColWidths_(headers, rows);
  const statusColIndex = headers.indexOf('Attendance Status');
  const ok = await downloadStyledXlsx('master-training-sheet.xlsx', 'Master Sheet', headers, rows, colWidths, {autoFilter:true, statusColIndex});
  if(ok) toast('Master sheet downloaded (matches the filtered/sorted preview)','ok');
}

async function exportAttendanceExcel(){
  const list = applyTrainerFilters(masterData);
  if(!list.length){ toast('No data to export','err'); return; }
  const headers = ['Pharmacist Name','Email','Supervisor','District','Area Manager','City','Date','Completion Rate','Attendance','Late Arrival Time','Notes'];
  const rows = [];
  list.forEach(p=>{
    const r = buildMasterRow(p);
    let lateTime = '';
    if(isSplitPerson(p)){
      const att = ops.attendance[p.id] || {};
      const parts = [];
      if(att.day1 && att.day1.status==='Attended' && att.day1.punctuality==='Late') parts.push('Day1: '+(att.day1.time||''));
      if(att.day2 && att.day2.status==='Attended' && att.day2.punctuality==='Late') parts.push('Day2: '+(att.day2.time||''));
      lateTime = parts.join(' / ');
    } else {
      const att = ops.attendance[p.id];
      lateTime = (att&&att.status==='Attended'&&att.punctuality==='Late')?(att.time||''):'';
    }
    rows.push([r.displayName,r.email,r.supervisor,r.district,r.areaManager,r.city,r.dateText,r.completionPct, r.statusText, lateTime, r.note]);
  });
  const colWidths = [28,28,20,14,18,12,24,10,16,14,26];
  const ok = await downloadStyledXlsx('training-attendance.xlsx', 'Attendance', headers, rows, colWidths);
  if(ok) toast('Excel downloaded','ok');
}



/* ═══════════════════════════════ TRAINER SIGN-IN + STARTUP ═══════════════════════════════ */
function showLoginGate(message){
  document.getElementById('screen-trainer').classList.add('hidden');
  document.getElementById('trainerBar').classList.add('hidden');
  document.getElementById('loginGate').classList.remove('hidden');
  const err = document.getElementById('loginError');
  if(message){ err.textContent = message; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
  setTimeout(()=>{ const u = document.getElementById('loginUser'); if(u) u.focus(); }, 0);
}
async function startTrainerApp(){
  document.getElementById('loginGate').classList.add('hidden');
  document.getElementById('screen-trainer').classList.remove('hidden');
  document.getElementById('trainerBar').classList.remove('hidden');
  loadLogo();
  await initTrainer();
}
async function submitLogin(ev){
  ev.preventDefault();
  const btn = document.getElementById('loginBtn');
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const err = document.getElementById('loginError');
  err.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try{
    await API.login(user, pass);
    document.getElementById('loginPass').value = '';
    await startTrainerApp();
  }catch(e){
    err.textContent = e.message || 'Sign-in failed';
    err.classList.remove('hidden');
    document.getElementById('loginPass').value = '';
  }
  btn.disabled = false; btn.textContent = 'Sign in';
}
function trainerSignOut(){
  API.logout();
  closeModal();
  window.location.href = 'index.html';
}
async function resyncAfterSaveFailure(){
  // a save was rejected (or failed) after acting on in-memory data — reload the real state so the screen matches the sheet
  await loadCoreData();
  buildTrainerFilterBar();
  renderTrainerTable();
  updatePendingDot();
}
window.addEventListener('DOMContentLoaded', async ()=>{
  API.init('trainer');
  APP_HOOKS.onAuthExpired = ()=>{ closeModal(); showLoginGate('Your session has ended — please sign in again.'); };
  APP_HOOKS.onSaveFailed = ()=>{ if(!document.getElementById('screen-trainer').classList.contains('hidden')) resyncAfterSaveFailure(); };
  initSyncStatusIndicator();
  if(await API.verifySession()) await startTrainerApp();
  else showLoginGate();
});