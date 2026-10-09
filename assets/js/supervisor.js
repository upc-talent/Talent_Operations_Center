/* Supervisor page logic. */
let supTrack = 'offline';
function switchSupTrack(track){
  supTrack = track;
  document.getElementById('supTrackTab-offline').classList.toggle('active', track==='offline');
  document.getElementById('supTrackTab-online').classList.toggle('active', track==='online');
  buildSupervisorFilterBar();
  renderSupervisorChips();
  renderSupervisorTable();
}
// Only show the Offline / Online tab when this supervisor actually has pharmacists of that kind (both show if they have none).
function updateSupTrackTabs(){
  const mine = masterData.filter(p=>p.supervisor===currentSupervisor);
  const hasOnline = mine.some(isOnlinePharmacist);
  const hasOffline = mine.some(p=>!isOnlinePharmacist(p));
  const showOffline = hasOffline || !hasOnline;
  const showOnline = hasOnline || !hasOffline;
  if(supTrack==='offline' && !showOffline) supTrack = 'online';
  if(supTrack==='online' && !showOnline) supTrack = 'offline';
  const off = document.getElementById('supTrackTab-offline'), on = document.getElementById('supTrackTab-online');
  off.classList.toggle('hidden', !showOffline);
  on.classList.toggle('hidden', !showOnline);
  off.classList.toggle('active', supTrack==='offline');
  on.classList.toggle('active', supTrack==='online');
}
function currentSupervisorScope(){
  return masterData.filter(p=>p.supervisor===currentSupervisor && isOnlinePharmacist(p) === (supTrack==='online'));
}
function currentSupervisorPendingScope(){
  return pendingList.filter(p=>p.supervisor===currentSupervisor && p.status==='Pending');
}

function buildSupervisorFilterBar(){
  const scope = currentSupervisorScope();
  const days = visibleDaysFor(currentSupervisor);
  document.getElementById('supFilterBar').innerHTML =
    `<div class="filter-field search-field"><div class="search-box"><span>🔍</span><input type="text" class="big-search-input" id="supSearchInput" value="${esc(supSearchQ)}" oninput="onSupSearch(this.value)" placeholder="Search name or email..."></div></div>` +
    renderMsFilter('sup','district','District', distinctValues(scope,'district').map(v=>({value:v,text:v}))) +
    renderMsFilter('sup','areaManager','Area Manager', distinctValues(scope,'areaManager').map(v=>({value:v,text:v}))) +
    renderMsFilter('sup','city','City', distinctValues(scope,'city').map(v=>({value:v,text:v}))) +
    renderMsFilter('sup','date','Date', dateFilterOptions(days)) +
    renderMsFilter('sup','retrain','Retraining', RETRAIN_FILTER_OPTIONS) +
    `<button class="btn btn-outline btn-sm" onclick="clearSupFilters()">Clear Filters</button>`;
}
function onSupSearch(v){ supSearchQ=v; renderSupervisorTable(); }
function clearSupFilters(){
  supFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), date:new Set(), retrain:new Set() };
  supSearchQ='';
  supStatusFilter = null;
  supMissingFilter = false;
  buildSupervisorFilterBar();
  renderSupervisorChips();
  renderSupervisorTable();
}

async function initSupervisor(){
  // Only the list of names is fetched here — a supervisor's own data is loaded after they pick their name.
  let names = [];
  try{ names = sortSupervisorNames((await API.supervisorNames()).filter(isValidSupervisorName)); }
  catch(e){ console.error(e); toast('Could not load the supervisor list — '+(e.message||'check your connection'),'err'); }
  const sel = document.getElementById('supervisorSelect');
  sel.innerHTML = names.length
    ? names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : `<option value="">No data available — contact the training coordinator</option>`;
  const last = await getPersonal('last-supervisor-name', null);
  if(last && names.includes(last)) sel.value = last;
  document.getElementById('supMain').classList.add('hidden');
}

async function loadSupervisorView(silent){
  const name = document.getElementById('supervisorSelect').value;
  if(!name){ toast('Please select your name first','err'); return; }
  if(name!==currentSupervisor){ supStatusFilter = null; supMissingFilter = false; }
  currentSupervisor = name;
  API.setSupervisor(name);
  await setPersonal('last-supervisor-name', name);
  await loadCoreData();
  const req = await getSharedMany([K_CHANGE_REQ, K_DATA_EDIT], {[K_CHANGE_REQ]:[], [K_DATA_EDIT]:[]});
  supChangeRequests = req[K_CHANGE_REQ] || [];
  supDataEdits = req[K_DATA_EDIT] || [];
  registerFilterFacets('sup', { items: currentSupervisorScope, values: {
    district: p=>[p.district], areaManager: p=>[p.areaManager], city: p=>[p.city],
    date: p=>{ const a = ops.assignments[p.id]; return [!a ? 'unassigned' : (a.type==='date' ? 'date:'+a.dateId : 'leave:'+a.status)]; },
    retrain: p=>[retrainKey(p)]
  }});

  document.getElementById('supMain').classList.remove('hidden');
  document.getElementById('supTitle').textContent = 'Pharmacists — ' + name;
  document.getElementById('capHintSup').textContent = trainingConfig.maxCapacity;

  updateSupTrackTabs();
  renderSupervisorChips();
  buildSupervisorFilterBar();
  renderSupervisorTable();
  onSupSelectionChange();
  startSupPresence();
  await checkSupervisorNotifications();
  if(!silent) toast('Loaded','ok');
}

async function openSubmissionHistoryModal(){
  const quotaHist = await getShared(K_QUOTA_HISTORY, []);
  leaveRequestsCache = await getShared(K_LEAVE_REQUESTS, []);
  const pendingDecided = pendingList.filter(p=>p.supervisor===currentSupervisor && (p.status==='Approved'||p.status==='Rejected'))
    .map(p=>({displayName:p.displayName, status:p.status, reason:p.rejectionReason||'', decidedAt:p.decidedAt, type:'New Pharmacist'}));
  const quotaDecided = quotaHist.filter(h=>h.supervisor===currentSupervisor)
    .map(h=>({displayName:h.displayName, status:h.status, reason:h.rejectionReason||'', decidedAt:h.decidedAt, type:'Over-Quota Assignment'}));
  const leaveDecided = leaveRequestsCache.filter(lr=>lr.supervisor===currentSupervisor && (lr.status==='Approved'||lr.status==='Rejected'))
    .map(lr=>({displayName:lr.displayName, status:lr.status, reason:lr.rejectionReason||'', decidedAt:lr.decidedAt, type:'Annual Leave'}));
  supChangeRequests = await getShared(K_CHANGE_REQ, []);
  const changeDecided = supChangeRequests.filter(r=>r.supervisor===currentSupervisor && (r.status==='Approved'||r.status==='Rejected'))
    .map(r=>({displayName:r.displayName, status:r.status, reason:r.rejectionReason||'', decidedAt:r.decidedAt, type:'Date Change'}));

  supDataEdits = await getShared(K_DATA_EDIT, []);
  const editDecided = supDataEdits.filter(r=>r.supervisor===currentSupervisor && r.status && r.status!=='Pending')
    .map(r=>({displayName:r.displayName, status:r.status, reason:r.decisionNote||r.rejectionReason||'', decidedAt:r.decidedAt, type:'Data Edit'}));

  const list = [...pendingDecided, ...quotaDecided, ...leaveDecided, ...changeDecided, ...editDecided]
    .sort((a,b)=> new Date(b.decidedAt||0) - new Date(a.decidedAt||0));

  const rows = list.length ? list.map((r,i)=>`
    <tr>
      <td class="name-cell" style="white-space:normal;min-width:160px;"><span class="rownum">${i+1}</span>${esc(r.displayName)}</td>
      <td style="white-space:normal;"><span class="badge badge-empty">${esc(r.type)}</span></td>
      <td><span class="badge ${r.status==='Approved'?'badge-date':(r.status==='Partially Approved'?'badge-pending':'badge-leave')}">${esc(r.status)}</span></td>
      <td style="white-space:normal;min-width:100px;">${esc(r.reason||'—')}</td>
      <td style="white-space:nowrap;">${r.decidedAt ? new Date(r.decidedAt).toLocaleDateString('en-GB') : '—'}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty-msg">No decisions yet</td></tr>`;
  showModal(`
    <h3>Submission History</h3>
    <p class="small-note">New pharmacists, over-quota assignments, Annual Leave, date change and data edit requests you've submitted, and what happened to them — these stay here permanently.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Pharmacist Name</th><th>Type</th><th>Status</th><th>Reason</th><th>Decided</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="modal-actions"><button class="btn btn-outline btn-sm" onclick="closeModal()">Close</button></div>`, 'max-width:820px;');

  let notifs = await getShared(K_NOTIF, []);
  notifs = notifs.map(n=> (n.supervisor===currentSupervisor && !n.seenInHistory) ? {...n, seenInHistory:true} : n);
  await setShared(K_NOTIF, notifs);
  await updateSubmissionHistoryDot(notifs);
}

async function checkSupervisorNotifications(){
  let notifs = await getShared(K_NOTIF, []);
  const mine = notifs.filter(n=>n.supervisor===currentSupervisor && !n.read);
  if(mine.length){
    mine.forEach(n=>{
      const msg = (n.result==='Rejected' || n.result==='Partially Approved') && n.reason ? `${n.pharmacistName}: ${n.result} — ${n.reason}` : `${n.pharmacistName}: ${n.result}`;
      toast(msg, n.result==='Rejected' ? 'err' : (n.result==='Approved' ? 'ok' : 'info'));
    });
    notifs = notifs.map(n=> (n.supervisor===currentSupervisor && !n.read) ? {...n, read:true} : n);
    await setShared(K_NOTIF, notifs);
  }
  await updateSubmissionHistoryDot(notifs);
}
// `notifs`, when passed, is a freshly-loaded list the caller already has — avoids fetching it again just for the dot count.
async function updateSubmissionHistoryDot(notifs){
  if(!notifs) notifs = await getShared(K_NOTIF, []);
  const count = notifs.filter(n=>n.supervisor===currentSupervisor && !n.seenInHistory).length;
  const dot = document.getElementById('submissionHistoryDot');
  if(dot) dot.innerHTML = count>0 ? `<span class="dot-badge dot-badge-glow">${count}</span>` : '';
}

function renderSupervisorChips(){
  const overviewEl = document.getElementById('supChipsOverview');
  const daysEl = document.getElementById('supChipsDays');
  const statusEl = document.getElementById('supChipsStatus');
  const days = visibleDaysFor(currentSupervisor).filter(d => !!d.isOnline === (supTrack==='online'));
  const own = currentSupervisorScope();

  const total = own.length;
  const onTime = own.filter(p=>attSummary(p.id,p).status==='Attended' && (attSummary(p.id,p).punctuality||'On Time')==='On Time').length;
  const late = own.filter(p=>attSummary(p.id,p).status==='Attended' && attSummary(p.id,p).punctuality==='Late').length;
  const attended = onTime + late;
  const notAssignedTotal = own.filter(p=>!ops.assignments[p.id]).length;
  const assignedButAbsent = own.filter(p=>ops.assignments[p.id]?.type==='date' && attSummary(p.id,p).status==='Absent').length;
  const pct = n => total ? Math.round((n/total)*100)+'% of total' : '—';
  const card = (kind, cls, inner) => statusCardHtml(kind, cls, inner, supStatusFilter, 'setSupStatusFilter');
  overviewEl.innerHTML =
    card('attended', 'ok', `<div class="lbl">Attended</div><div class="num">${attended}</div><div class="tag">${onTime} On Time · ${late} Late</div>`) +
    card('notAssigned', 'neutral', `<div class="lbl">Not Assigned</div><div class="num">${notAssignedTotal}</div><div class="tag">${pct(notAssignedTotal)}</div>`) +
    card('absent', 'danger', `<div class="lbl">Assigned but Absent</div><div class="num">${assignedButAbsent}</div><div class="tag">${pct(assignedButAbsent)}</div>`);

  if(!days.length){
    daysEl.innerHTML = `<p class="small-note">No ${supTrack} training days have been assigned to you yet.</p>`;
  } else {
    daysEl.innerHTML = days.map(d=>{
      const count = dayCount(d.id);
      const cap = dayCapacity(d);
      const st = capacityStatus(count, cap);
      const passed = isDeadlinePassed(d);
      const deadlineHtml = d.deadline
        ? `<span class="tag" style="display:inline-block;margin:0;background:${passed?'var(--danger-bg)':'rgba(255,255,255,.6)'};color:${passed?'var(--danger)':'inherit'};">Deadline: ${formatDateTime(d.deadline)}${passed?' — Passed':''}</span>`
        : '';
      let quotaHtml = '';
      if(d.supervisorQuotas && d.supervisorQuotas[currentSupervisor]!==undefined){
        const quota = d.supervisorQuotas[currentSupervisor];
        const mine = own.filter(p=>ops.assignments[p.id]?.type==='date' && ops.assignments[p.id]?.dateId===d.id).length;
        const remaining = Math.max(quota-mine, 0);
        const reached = mine>=quota;
        quotaHtml = `<span class="tag" title="${reached?`Your quota is ${quota}. You can still add pharmacists, but any beyond the quota will need the trainer's approval.`:`Your quota for this day is ${quota}. You've used ${mine} so far.`}" style="display:inline-block;margin:0;padding:3px 8px;font-size:10px;font-weight:500;line-height:1.3;border-radius:20px;${reached?`background:var(--pending);color:#fff;`:`background:rgba(255,255,255,.9);color:var(--pending);border:1.5px solid var(--pending);`}">
          ${reached ? `⚠️ <b>${mine}/${quota} reached</b>` : `<b>Quota ${mine}/${quota}</b> · ${remaining} left`}
        </span>`;
      }
      return `<div class="chip chip-lg ${st.cls}"><div class="lbl">${esc(dayGroupText(d))}</div>${isDayEditableForSup(d) ? '' : '<div class="small-note" style="font-weight:700;">🔒 Managed by the training team</div>'}<div class="num">${count} / ${cap}</div><div class="row" style="gap:5px;margin-top:5px;flex-wrap:wrap;"><span class="tag" style="margin:0;">${st.tag}</span>${quotaHtml}${deadlineHtml}</div></div>`;
    }).join('');
  }

  let statusHtml = `<div class="chip neutral"><div class="lbl">Total Pharmacists</div><div class="num">${total}</div></div>`;
  LEAVE_STATUSES.forEach(s=>{
    const count = own.filter(p=>ops.assignments[p.id]?.type==='leave' && ops.assignments[p.id]?.status===s).length;
    statusHtml += `<div class="chip neutral"><div class="lbl">${s}</div><div class="num">${count}</div></div>`;
  });
  const notAssigned = own.filter(p=>!ops.assignments[p.id]).length;
  statusHtml += `<div class="chip neutral"><div class="lbl">Not Assigned</div><div class="num">${notAssigned}</div></div>`;
  const pendCount = currentSupervisorPendingScope().length;
  statusHtml += `<div class="chip pending"><div class="lbl">Pending Approval</div><div class="num">${pendCount}</div></div>`;
  statusEl.innerHTML = statusHtml;
}

// Pharmacist Status card chosen as a table filter ('attended' | 'notAssigned' | 'absent'), or null for everyone.
let supStatusFilter = null;
function setSupStatusFilter(kind){
  supStatusFilter = (kind && kind!==supStatusFilter) ? kind : null;
  if(supStatusFilter) supMissingFilter = false;
  renderSupervisorChips();
  renderSupervisorTable();
  if(supStatusFilter){
    const card = document.getElementById('supTableCard');
    if(card) card.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function applySupFilters(list){
  const status = supStatusFilter ? STATUS_GROUPS[supStatusFilter].test : null;
  return list.filter(p=>{
    if(status && !status(p)) return false;
    if(supMissingFilter && !isMissingSubmitData(p)) return false;
    if(!inSet(p.district, supFilterState.district)) return false;
    if(!inSet(p.areaManager, supFilterState.areaManager)) return false;
    if(!inSet(p.city, supFilterState.city)) return false;
    if(!matchesDateSet(p.id, supFilterState.date)) return false;
    if(!inSet(retrainKey(p), supFilterState.retrain)) return false;
    if(supSearchQ){
      const q = supSearchQ.toLowerCase();
      if(!p.displayName.toLowerCase().includes(q) && !(p.email||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function renderSupervisorTable(){
  // the "missing Date / Work Shift" view ends by itself once nothing is missing any more
  if(supMissingFilter && !masterData.some(p=>p.supervisor===currentSupervisor && isMissingSubmitData(p))) supMissingFilter = false;
  let own = applySupFilters(currentSupervisorScope());
  // New pharmacists still awaiting approval belong to none of the status cards, so a card filter hides them.
  const pending = (supStatusFilter || supMissingFilter) ? [] : applySupFilters(currentSupervisorPendingScope());
  const tag = document.getElementById('supStatusTag');
  if(tag) tag.innerHTML = supMissingFilter
    ? `<span class="status-filter-tag">Showing: Training day without a Work Shift <button type="button" title="Show everyone" onclick="setSupMissingFilter(false)">✕</button></span>`
    : statusFilterTagHtml(supStatusFilter, 'setSupStatusFilter');
  own = applySort('sup', own);
  const days = visibleDaysFor(currentSupervisor);
  const tb = document.getElementById('supTableBody');
  if(!own.length && !pending.length){
    tb.innerHTML = `<tr><td colspan="10" class="empty-msg">No pharmacists match the current filters</td></tr>`;
    updateSortIndicators('sup');
    bulkSyncAfterRender('sup', []);
    return;
  }
  let i = 0;
  // Column order: Pharmacist Name (with its row number), Pharmacy No., Email, Date, Attendance Status, Work Shift, Core %, Capsule %, Notes
  ['core','capsule'].forEach(slot=>{ const th = document.getElementById('th-sup-'+slot); if(th) th.title = courseSlotHeaderTitle(slot); });
  const nameCell = (n, p) => `<td class="name-cell"><span class="rownum">${n}</span>${esc(p.displayName)}</td>`;
  let rows = own.map(p=>{
    i++;
    const lock = supLockReason(p);
    let dateHtml = lock
      ? `${dateCellHtml(p, false, days, 'onAssignChange')}<div class="locked-note" title="${esc(SUP_LOCK_TEXT[lock].title)}">${SUP_LOCK_TEXT[lock].note}</div>`
      : dateCellHtml(p, true, days, 'onAssignChange');
    if(!lock && ops.assignments[p.id]?.locked && isFailedAttendance(p)) dateHtml += `<div class="retrain-note">↻ Missed the training — pick a new day</div>`;
    if(pendingChangeFor(p.id)) dateHtml += `<div class="small-note" style="color:var(--pending);font-weight:700;">⏳ Change requested</div>`;
    const editReq = pendingDataEditFor(p.id);
    const editNote = editReq ? `<div class="small-note edit-pending">✎ Edit requested <button type="button" class="link-btn" onclick="cancelDataEdit('${editReq.id}')">cancel</button></div>` : '';
    return `<tr>
      ${bulkCheckboxCell('sup', p.id)}
      ${nameCell(i, p).replace(/<\/td>$/, editNote+'</td>')}
      <td>${esc(p.pharmacyNo||'—')}</td>
      <td class="email-cell">${esc(p.email||'—')}</td>
      <td class="no-truncate">${dateHtml}</td>
      <td class="no-truncate">${attendanceBadgeHtml(p)}</td>
      <td class="${supMissingFilter && isMissingSubmitData(p) ? 'cell-missing' : ''}">${workShiftSelectHtml(p)}</td>
      <td>${courseSlotPctHtml(p, 'core')}</td>
      <td>${courseSlotPctHtml(p, 'capsule')}</td>
      <td class="no-truncate">${p.note ? `<span class="sup-note">${esc(p.note)}</span>` : '<span class="small-note">—</span>'}</td>
    </tr>`;
  }).join('');
  rows += pending.map(p=>{
    i++;
    return `<tr class="pending-row">
      <td class="sel-cell"></td>
      ${nameCell(i, p)}
      <td>${esc(p.pharmacyNo||'—')}</td>
      <td class="email-cell">${esc(p.email||'—')}</td>
      <td class="no-truncate"><span class="badge badge-pending">Pending Approval</span><br>
        <button class="btn btn-outline btn-sm" style="margin-top:4px;" onclick="openEditPendingModal('${p.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" style="margin-top:4px;" onclick="deletePendingPharmacist('${p.id}')">Delete</button>
      </td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
    </tr>`;
  }).join('');
  tb.innerHTML = rows;
  updateSortIndicators('sup');
  bulkSyncAfterRender('sup', own.map(p=>p.id));
  onSupSelectionChange();
}

/* ═══════════════════════════════ LOCKS: SUBMIT, TRAINER-MANAGED DAYS, RETRAINING ═══════════════════════════════
   A choice is free until the supervisor presses Submit; then it is locked (the server enforces all of this too).
   A pharmacist who missed their training (Absent, or one day of a 2-day online training) can be booked onto a
   new day the training team opens for this supervisor. A day that is visible but not editable for this supervisor
   ("readOnlySupervisors") can't be picked, and nobody on it can be moved — except through Request Change. */
function isFailedAttendance(p){ const s = attSummary(p.id, p).status; return s==='Absent' || s==='Partial'; }
function isDayEditableForSup(d){ return !(d && (d.readOnlySupervisors||[]).includes(currentSupervisor)); }
function supEditableDays(){ return visibleDaysFor(currentSupervisor).filter(isDayEditableForSup); }
// The days this supervisor may pick for this pharmacist (the dropdown list); a missed day isn't offered again.
function supAssignableDays(pid){
  const p = masterData.find(m=>m.id===pid);
  const cur = ops.assignments[pid];
  const missed = p && isFailedAttendance(p) && cur && cur.type==='date' ? cur.dateId : null;
  return supEditableDays().filter(d=>d.id!==missed);
}
// Why the supervisor can't change this pharmacist themselves — or null when they can.
function supLockReason(p){
  if(hasAttendedTraining(p)) return 'attended';
  if(isFailedAttendance(p)) return null;
  const a = ops.assignments[p.id];
  if(a && a.locked) return 'submitted';
  if(a && a.type==='date' && !isDayEditableForSup(dayById(a.dateId))) return 'managed';
  // no date yet, and every day this supervisor can see for them is managed by the training team → the whole slot is locked
  if((!a || a.type!=='date') && supNoDateSlotLocked(p)) return 'managed';
  return null;
}
function supNoDateSlotLocked(p){
  const online = isOnlinePharmacist(p);
  const days = visibleDaysFor(currentSupervisor).filter(d=>!!d.isOnline===online);
  return days.length>0 && days.every(d=>!isDayEditableForSup(d));
}
const SUP_LOCK_TEXT = {
  attended:  {note:'🔒 Attended — can\'t be reassigned', title:'This pharmacist already attended the training. Only the training team can change it.'},
  submitted: {note:'🔒 Submitted — use Request Change', title:'You submitted this choice, so it is locked. Tick the pharmacist and use Request Change to ask the training team for a different one.'},
  managed:   {note:'🔒 Managed by the training team — use Request Change', title:'The training team manages this day. Tick the pharmacist and use Request Change if they need a different one.'}
};
function currentChoiceText(p){
  const a = ops.assignments[p.id];
  if(!a) return 'Not Assigned';
  if(a.type==='leave') return a.status;
  const d = dayById(a.dateId);
  return d ? dayGroupText(d) : 'Not Assigned';
}

// Submit locks what has been filled so far; empty rows stay open and can be submitted later. The one rule: a
// pharmacist booked on a TRAINING DAY (not a leave status) needs a Work Shift. If any don't, the table shows just
// those, with the empty Work Shift cells outlined in red.
function isMissingSubmitData(p){ const a = ops.assignments[p.id]; return !!(a && a.type==='date') && !(ops.shifts && ops.shifts[p.id]); }
let supMissingFilter = false;
function setSupMissingFilter(on){
  supMissingFilter = !!on;
  renderSupervisorTable();
}
async function submitSupervisorChoices(){
  const mine = masterData.filter(p=>p.supervisor===currentSupervisor);
  const missing = mine.filter(isMissingSubmitData);
  if(missing.length){
    supStatusFilter = null;
    supMissingFilter = true;
    // show the tab (Offline / Online) that has missing pharmacists
    if(!missing.some(p=>isOnlinePharmacist(p)===(supTrack==='online'))) switchSupTrack(supTrack==='online' ? 'offline' : 'online');
    renderSupervisorChips();
    renderSupervisorTable();
    const card = document.getElementById('supTableCard');
    if(card) card.scrollIntoView({behavior:'smooth', block:'start'});
    toast(`Can't submit yet — ${missing.length} pharmacist(s) booked on a training day still need a Work Shift (shown below, in red)`, 'err');
    return;
  }
  const toLock = mine.filter(p=>{ const a = ops.assignments[p.id]; return a && !a.locked; });
  const empty = mine.filter(p=>!ops.assignments[p.id]).length;
  if(!toLock.length){ toast(empty ? 'Nothing new to submit — choose a Date or status for more pharmacists first' : 'Everything you have chosen is already submitted', 'info'); return; }
  const go = await confirmDialog(`Submit ${toLock.length} pharmacist(s)? Their dates and statuses will be locked and the training team will be notified. To change a locked pharmacist afterwards you'll need to send a Request Change.`
    + (empty ? ` ${empty} pharmacist(s) with no Date yet stay open — you can fill them and Submit again later.` : ''));
  if(!go) return;
  if(!await setShared(K_OPS, ops)) return;   // every change made on this page reaches the server before locking
  try{
    const n = await API.submit();
    toast(n ? `Submitted — ${n} pharmacist(s) locked and the training team notified` : 'Nothing new to submit', 'ok');
  }catch(e){ toast('Submit failed — '+(e.message||'please try again'), 'err'); return; }
  await loadSupervisorView(true);
}

/* Request Change: for pharmacists the supervisor can't change themselves. Goes to the trainer's Approvals tab. */
let supChangeRequests = [];
function pendingChangeFor(pid){ return supChangeRequests.find(r=>r.pharmacistId===pid && r.status==='Pending'); }
// Only for pharmacists the supervisor can't change themselves: submitted (locked) or managed by the training team.
function canRequestChange(p){ const r = supLockReason(p); return r==='submitted' || r==='managed'; }
function onSupSelectionChange(){
  const eb = document.getElementById('requestEditBtn');
  if(eb){ eb.disabled = !bulkSel.sup.size; eb.title = bulkSel.sup.size ? 'Ask the training team to correct the ticked pharmacists\' details' : 'Tick pharmacists in the table first'; }
  const b = document.getElementById('requestChangeBtn');
  if(!b) return;
  const anyLocked = masterData.some(p=>p.supervisor===currentSupervisor && canRequestChange(p));
  b.classList.toggle('hidden', !anyLocked);
  const eligible = [...bulkSel.sup].map(id=>masterData.find(m=>m.id===id)).filter(p=>p && canRequestChange(p)).length;
  b.disabled = !eligible;
  b.title = eligible ? 'Ask the training team to change the ticked locked pharmacists'
    : (bulkSel.sup.size ? 'Request Change is only for submitted or training-team-managed (🔒) pharmacists — change the others directly in the table' : 'Tick locked (🔒) pharmacists in the table first');
}
function openRequestChangeModal(){
  const selected = [...bulkSel.sup].map(id=>masterData.find(m=>m.id===id)).filter(Boolean);
  if(!selected.length){ toast('Tick pharmacists in the table first','err'); return; }
  const lockedSel = selected.filter(canRequestChange);
  const notLocked = selected.length - lockedSel.length;
  if(!lockedSel.length){ toast('Request Change is only for submitted or training-team-managed (🔒) pharmacists — change the others directly in the table','info'); return; }
  const people = lockedSel.filter(p=>!pendingChangeFor(p.id));
  const waiting = lockedSel.length - people.length;
  if(!people.length){ toast('The ticked pharmacists already have a change request waiting','info'); return; }
  // Target days follow each pharmacist's own type (online / in-person); a mixed selection gets both lists.
  const kinds = new Set(people.map(p=>isOnlinePharmacist(p)));
  const days = visibleDaysFor(currentSupervisor).filter(d=>kinds.has(!!d.isOnline));
  const opts = `<option value="">— choose —</option>`
    + `<optgroup label="Training Days">${days.map(d=>`<option value="date:${d.id}">${d.isOnline?'🌐 ':''}${esc(dayGroupText(d))}</option>`).join('')}</optgroup>`
    + `<optgroup label="Other Status">${LEAVE_STATUSES.map(s=>`<option value="leave:${esc(s)}">${esc(s)}</option>`).join('')}</optgroup>`
    + `<option value="__none__">Not Assigned</option>`;
  showModal(`<h3>Request Change — ${people.length} pharmacist(s)</h3>
    <p class="small-note">The training team reviews the request in their Approvals tab; you'll see their decision in your notifications and Submission History.</p>
    <ul class="req-list">${people.map(p=>`<li><b>${esc(p.displayName)}</b> <span class="small-note">— now: ${esc(currentChoiceText(p))}</span></li>`).join('')}</ul>
    ${waiting ? `<p class="small-note">${waiting} ticked pharmacist(s) already have a request waiting and are left out.</p>` : ''}
    ${notLocked ? `<p class="small-note">${notLocked} ticked pharmacist(s) aren't locked and are left out — change them directly in the table.</p>` : ''}
    ${kinds.size>1 ? `<p class="small-note">A training day only applies to pharmacists of the same type (🌐 online / in-person); the others are left out.</p>` : ''}
    <div class="field"><label class="field-label req">Change to</label><select id="reqChangeTo">${opts}</select></div>
    <div class="field"><label class="field-label req">Reason</label><textarea id="reqChangeReason" rows="3" placeholder="Why is the change needed?"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" onclick="sendChangeRequest()">Send Request</button>
    </div>`, 'max-width:620px;');
}
async function sendChangeRequest(){
  const val = document.getElementById('reqChangeTo').value;
  const reason = document.getElementById('reqChangeReason').value.trim();
  if(!val){ toast('Choose what to change to','err'); return; }
  if(!reason){ toast('Please give a reason for the training team','err'); return; }
  let to = null;
  if(val!=='__none__'){ const [type, rest] = val.split(':'); to = type==='date' ? {type:'date', dateId:rest} : {type:'leave', status:rest}; }
  const targetDay = to && to.type==='date' ? dayById(to.dateId) : null;
  const people = [...bulkSel.sup].map(id=>masterData.find(m=>m.id===id))
    .filter(p=>p && canRequestChange(p) && !pendingChangeFor(p.id) && (!targetDay || !!targetDay.isOnline===isOnlinePharmacist(p)));
  if(!people.length){ toast('None of the ticked pharmacists can move to that day (online and in-person days don\'t mix)','err'); return; }
  supChangeRequests = await getShared(K_CHANGE_REQ, []);
  const now = nowIso();
  people.forEach(p=>{
    const cur = ops.assignments[p.id];
    supChangeRequests.push({id:uid('chg'), supervisor:currentSupervisor, pharmacistId:p.id, displayName:p.displayName, email:p.email||'',
      from: cur ? (cur.type==='date' ? {type:'date', dateId:cur.dateId} : {type:'leave', status:cur.status}) : null,
      to, reason, requestedAt:now, status:'Pending'});
  });
  const ok = await setShared(K_CHANGE_REQ, supChangeRequests);
  closeModal();
  if(ok){
    bulkClear('sup');
    renderSupervisorTable();
    toast(`Request sent for ${people.length} pharmacist(s) — the training team will review it`,'ok');
  }
}

/* Request Data Edit: ask the training team to correct a pharmacist's details (name, email, pharmacy no., employee
   ID, phone, SCFHS, city / online-physical). Works for any of the supervisor's own pharmacists, locked or not. The
   trainer approves all, some or none of the changes; the outcome arrives in notifications and Submission History. */
let supDataEdits = [];
function pendingDataEditFor(pid){ return supDataEdits.find(r=>r.pharmacistId===pid && r.status==='Pending'); }
function openDataEditModal(){
  const selected = [...bulkSel.sup].map(id=>masterData.find(m=>m.id===id)).filter(Boolean);
  if(!selected.length){ toast('Tick pharmacists in the table first','err'); return; }
  const people = selected.filter(p=>!pendingDataEditFor(p.id)).slice(0, 15);
  const waiting = selected.filter(p=>pendingDataEditFor(p.id)).length;
  if(!people.length){ toast('The ticked pharmacists already have an edit request waiting','info'); return; }
  const cities = allKnownCities().filter(c=>c.trim().toLowerCase()!=='online');
  const block = p=>{
    const online = isOnlinePharmacist(p);
    const input = f=> f.hidden
      ? `<input class="de-in" data-pid="${p.id}" data-field="${f.key}" placeholder="Not shown — type a new value to change it">`
      : `<input class="de-in" data-pid="${p.id}" data-field="${f.key}" value="${esc(p[f.key]||'')}">`;
    return `<div class="de-block">
      <div class="de-head">${esc(p.displayName)} <span class="small-note">${esc(p.email||'')}</span></div>
      <div class="de-grid">
        ${DATA_EDIT_FIELDS.filter(f=>f.key!=='city').map(f=>`<label><span class="field-label">${esc(f.label)}</span>${input(f)}</label>`).join('')}
        <label><span class="field-label">Training type</span>
          <select class="de-type" data-pid="${p.id}" onchange="this.closest('.de-block').querySelector('.de-city').disabled = this.value==='online'">
            <option value="physical" ${online?'':'selected'}>Physical (in person)</option><option value="online" ${online?'selected':''}>Online</option></select></label>
        <label><span class="field-label">City (physical)</span>
          <select class="de-city" data-pid="${p.id}" ${online?'disabled':''}><option value="">— choose —</option>${cities.map(c=>`<option ${c===p.city?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      </div></div>`;
  };
  showModal(`<h3>Request Data Edit — ${people.length} pharmacist(s)</h3>
    <p class="small-note">Change only what is wrong; the training team reviews each change and can accept some and refuse others. You'll see their decision in your notifications and Submission History.</p>
    ${waiting ? `<p class="small-note">${waiting} ticked pharmacist(s) already have an edit request waiting and are left out.</p>` : ''}
    ${selected.length - waiting > 15 ? `<p class="small-note">Only the first 15 are shown — send the rest in another request.</p>` : ''}
    <div class="de-list">${people.map(block).join('')}</div>
    <div class="field"><label class="field-label req">Reason</label><textarea id="deReason" rows="2" placeholder="What is wrong / where does the correct information come from?"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" onclick="sendDataEditRequest()">Send Request</button>
    </div>`, 'max-width:860px;');
}
async function sendDataEditRequest(){
  const reason = document.getElementById('deReason').value.trim();
  if(!reason){ toast('Please give a reason for the training team','err'); return; }
  const pids = [...new Set([...document.querySelectorAll('.de-block .de-in')].map(i=>i.dataset.pid))];
  const requests = [];
  for(const pid of pids){
    const p = masterData.find(m=>m.id===pid);
    if(!p) continue;
    const changes = [];
    document.querySelectorAll(`.de-in[data-pid="${pid}"]`).forEach(inp=>{
      const f = DATA_EDIT_FIELDS.find(x=>x.key===inp.dataset.field);
      const v = inp.value.trim();
      if(f.hidden){ if(v) changes.push({field:f.key, from:'', to:v}); }
      else if(v && v!==(p[f.key]||'')) changes.push({field:f.key, from:p[f.key]||'', to:v});
    });
    const type = document.querySelector(`.de-type[data-pid="${pid}"]`).value;
    const city = type==='online' ? 'Online' : document.querySelector(`.de-city[data-pid="${pid}"]`).value;
    if(type==='physical' && !city){ toast(`Choose the city for ${p.displayName} (physical training)`,'err'); return; }
    if(city && city!==p.city) changes.push({field:'city', from:p.city||'', to:city});
    const em = changes.find(c=>c.field==='email');
    if(em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.to)){ toast(`The email for ${p.displayName} doesn't look right`,'err'); return; }
    if(em && masterData.some(m=>m.id!==p.id && (m.email||'').toLowerCase()===em.to.toLowerCase())){ toast(`${em.to} already belongs to another of your pharmacists`,'err'); return; }
    if(changes.length) requests.push({id:uid('edt'), supervisor:currentSupervisor, pharmacistId:p.id, displayName:p.displayName, email:p.email||'',
      changes, reason, requestedAt:nowIso(), status:'Pending'});
  }
  if(!requests.length){ toast('Nothing was changed','info'); return; }
  supDataEdits = await getShared(K_DATA_EDIT, []);
  supDataEdits.push(...requests);
  const ok = await setShared(K_DATA_EDIT, supDataEdits);
  closeModal();
  if(ok){
    bulkClear('sup');
    renderSupervisorTable();
    toast(`Edit request sent for ${requests.length} pharmacist(s) — the training team will review it`,'ok');
  } else supDataEdits = await getShared(K_DATA_EDIT, []);
}
async function cancelDataEdit(id){
  if(!await confirmDialog('Cancel this data edit request?')) return;
  supDataEdits = await getShared(K_DATA_EDIT, []);
  const i = supDataEdits.findIndex(r=>r.id===id && r.status==='Pending');
  if(i<0){ toast('That request was already decided','info'); renderSupervisorTable(); return; }
  supDataEdits.splice(i,1);
  if(await setShared(K_DATA_EDIT, supDataEdits)){ toast('Request cancelled','ok'); renderSupervisorTable(); }
}

/* Work Shift (Morning / Night), chosen per pharmacist — always editable, even after Submit. */
const WORK_SHIFTS = ['Morning Shift','Night Shift'];
// Night Shift shows red, Morning Shift green.
const shiftClass = v=> v==='Night Shift' ? 'shift-night' : (v==='Morning Shift' ? 'shift-morning' : '');
function workShiftSelectHtml(p){
  const cur = (ops.shifts && ops.shifts[p.id]) || '';
  return `<select class="shift-select ${shiftClass(cur)}" onchange="onShiftChange('${p.id}', this.value, this)"><option value="" ${cur?'':'selected'}>—</option>${WORK_SHIFTS.map(s=>`<option value="${s}" ${cur===s?'selected':''}>${s}</option>`).join('')}</select>`;
}
function onShiftChange(pid, value, el){
  if(!ops.shifts) ops.shifts = {};
  if(value) ops.shifts[pid] = value; else delete ops.shifts[pid];
  if(el) el.className = 'shift-select '+shiftClass(value);
  toast('Saved','ok');
  saveShared(K_OPS, ()=>ops);
  if(supMissingFilter) renderSupervisorTable();
}

/* "Supervisors online" on the trainer page: ping every minute while this page is open (a closed page drops off
   the count within ~2½ minutes). */
let supPresenceTimer = null;
function startSupPresence(){
  const ping = ()=>{ if(currentSupervisor) API.ping().catch(()=>{}); };
  ping();
  if(!supPresenceTimer) supPresenceTimer = setInterval(ping, 60000);
}

/* ═══════════════════════════════ BULK ASSIGN (SUPERVISOR) ═══════════════════════════════ */
// Assign / set-leave / unassign the selected pharmacists. Respects the same rules the single-row dropdown does
// (online↔offline, deadline, capacity, quota) and skips any that don't fit, reporting the counts.
function bulkApplySupAssign(){
  const sel = document.getElementById('bulkAssignSelect-sup');
  const value = sel ? sel.value : '';
  if(!value){ toast('Choose what to assign first','err'); return; }
  const selected = [...bulkSel.sup].map(id=>masterData.find(m=>m.id===id)).filter(Boolean);
  if(!selected.length) return;
  // attended, submitted (locked) or on a day the training team manages → never changed here (Request Change instead)
  const people = selected.filter(p=>!supLockReason(p));
  const attendedSkipped = selected.filter(p=>supLockReason(p)==='attended').length;
  const lockedSkipped = selected.length - people.length - attendedSkipped;
  if(!people.length){ toast('The selected pharmacists are locked (attended or submitted) — use Request Change.','err'); return; }
  let done = 0, skipped = 0, pending = 0;
  if(value==='__none__'){
    people.forEach(p=>{ delete ops.assignments[p.id]; delete ops.attendance[p.id]; done++; });
  } else {
    const [type, rest] = value.split(':');
    if(type==='leave'){
      people.forEach(p=>{ ops.assignments[p.id] = {type:'leave', status:rest, assignedBy:currentSupervisor, assignedAt:nowIso()}; delete ops.attendance[p.id]; done++; });
    } else {
      const day = dayById(rest);
      if(!day || day.active===false){ toast('That training day is not open.','err'); return; }
      if(!isDayEditableForSup(day)){ toast('The training team manages that day — use Request Change.','err'); return; }
      if(isDeadlinePassed(day)){ toast('The deadline for that training day has passed.','err'); return; }
      const cap = dayCapacity(day);
      let count = dayCount(rest);   // everyone currently on the day
      const quota = (day.supervisorQuotas && day.supervisorQuotas[currentSupervisor]!==undefined) ? Number(day.supervisorQuotas[currentSupervisor]) : null;
      let mine = masterData.filter(m=>m.supervisor===currentSupervisor && ops.assignments[m.id]?.type==='date' && ops.assignments[m.id]?.dateId===rest).length;
      people.forEach(p=>{
        if(isOnlinePharmacist(p) !== !!day.isOnline){ skipped++; return; }   // wrong type for this day
        const alreadyHere = ops.assignments[p.id]?.type==='date' && ops.assignments[p.id]?.dateId===rest;
        if(alreadyHere) return;   // no-op
        if(count >= cap){ skipped++; return; }   // day full
        const overQuota = quota!==null && mine>=quota;
        ops.assignments[p.id] = {type:'date', dateId:rest, assignedBy:currentSupervisor, assignedAt:nowIso(), overQuota, quotaApproved:!overQuota};
        delete ops.attendance[p.id];
        count++; mine++; done++; if(overQuota) pending++;
      });
    }
  }
  bulkSel.sup.clear();
  renderSupervisorChips();
  renderSupervisorTable();
  saveShared(K_OPS, ()=>ops);
  let msg = `Updated ${done} pharmacist(s)`;
  if(pending) msg += ` (${pending} over quota — pending trainer approval)`;
  if(skipped) msg += `, skipped ${skipped} (day full or wrong type)`;
  if(attendedSkipped) msg += `, skipped ${attendedSkipped} (already attended)`;
  if(lockedSkipped) msg += `, skipped ${lockedSkipped} (locked — use Request Change)`;
  toast(msg, (skipped||pending||attendedSkipped||lockedSkipped)?'info':'ok');
}

function openEditPendingModal(pid){
  const p = pendingList.find(x=>x.id===pid && x.status==='Pending');
  if(!p) return;
  showModal(`
    <h3>Edit Submission</h3>
    <p class="small-note">Still pending — you can correct any detail before the trainer reviews it.</p>
    <div class="field"><label class="field-label req">Display Name (Pharmacist Name)</label><input type="text" id="editPhName" value="${esc(p.displayName)}"></div>
    <div class="field-grid">
      <div class="field"><label class="field-label req">Pharmacy No.</label><input type="text" id="editPhPharmacyNo" value="${esc(p.pharmacyNo)}"></div>
      <div class="field"><label class="field-label req">User/Employee ID</label><input type="text" id="editPhEmpId" value="${esc(p.employeeId)}"></div>
      <div class="field"><label class="field-label req">Username (Email)</label><input type="text" id="editPhEmail" value="${esc(p.email)}"></div>
      <div class="field"><label class="field-label req">Phone (WhatsApp)</label><input type="text" id="editPhPhone" value="${esc(p.phone)}"></div>
      <div class="field"><label class="field-label req">SCFHS</label><input type="text" id="editPhScfhs" value="${esc(p.scfhs)}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" onclick="confirmEditPending('${pid}')">Save</button>
    </div>`);
}
async function confirmEditPending(pid){
  const displayName = document.getElementById('editPhName').value.trim();
  const pharmacyNo = document.getElementById('editPhPharmacyNo').value.trim();
  const employeeId = document.getElementById('editPhEmpId').value.trim();
  const email = document.getElementById('editPhEmail').value.trim();
  const phone = document.getElementById('editPhPhone').value.trim();
  const scfhs = document.getElementById('editPhScfhs').value.trim();
  if(!displayName || !pharmacyNo || !employeeId || !email || !phone || !scfhs){
    toast('All fields are required','err'); return;
  }
  pendingList = await getShared(K_PENDING, []);
  const item = pendingList.find(x=>x.id===pid);
  if(item){ Object.assign(item, {displayName, pharmacyNo, employeeId, email, phone, scfhs}); }
  const ok = await setShared(K_PENDING, pendingList);
  closeModal();
  if(ok){ toast('Updated','ok'); renderSupervisorTable(); }
}
async function deletePendingPharmacist(pid){
  const go = await confirmDialog('Delete this submission? You can add them again from scratch afterwards.');
  if(!go) return;
  pendingList = await getShared(K_PENDING, []);
  pendingList = pendingList.filter(x=>x.id!==pid);
  const ok = await setShared(K_PENDING, pendingList);
  if(ok){ toast('Deleted','ok'); renderSupervisorChips(); renderSupervisorTable(); }
}

async function onAssignChange(pid, value){
  const person = masterData.find(m=>m.id===pid);
  const lock = person && supLockReason(person);
  if(lock){
    toast(lock==='attended' ? 'This pharmacist already attended their training — only the training team can change it.' : 'This pharmacist is locked — use Request Change.','err');
    renderSupervisorTable();
    return;
  }
  if(!value){
    delete ops.assignments[pid];
    delete ops.attendance[pid];
  } else {
    const [type, rest] = value.split(':');
    if(type==='date'){
      if(isDayFull(rest, pid)){
        const capD = dayById(rest);
        toast(`This day is at full capacity (${dayCapacity(capD)}). Please choose another day.`, 'err');
        renderSupervisorTable();
        return;
      }
      const day = dayById(rest);
      let overQuota = false;
      if(day && day.supervisorQuotas && day.supervisorQuotas[currentSupervisor]!==undefined){
        const quota = day.supervisorQuotas[currentSupervisor];
        const currentCount = Object.entries(ops.assignments||{}).filter(([opid,a])=>
          opid!==pid && a.type==='date' && a.dateId===rest && masterData.find(m=>m.id===opid)?.supervisor===currentSupervisor
        ).length;
        if(currentCount >= quota) overQuota = true;
      }
      const prev = ops.assignments[pid];
      ops.assignments[pid] = {type:'date', dateId:rest, assignedBy:currentSupervisor, assignedAt: nowIso(), overQuota, quotaApproved: !overQuota};
      // a new day starts with no attendance (e.g. re-booking someone who missed their training)
      if(!prev || prev.type!=='date' || prev.dateId!==rest) delete ops.attendance[pid];
      renderSupervisorChips();
      renderSupervisorTable();
      toast(overQuota ? `You've reached your quota for this day — this assignment needs the trainer's approval first.` : 'Saved', overQuota ? 'info' : 'ok');
      saveShared(K_OPS, ()=>ops);
      return;
    } else {
      ops.assignments[pid] = {type:'leave', status:rest, assignedBy:currentSupervisor, assignedAt: nowIso()};
      delete ops.attendance[pid];
    }
  }
  renderSupervisorChips();
  renderSupervisorTable();
  toast('Saved','ok');
  saveShared(K_OPS, ()=>ops);
}
function openAddPharmacistModal(){
  const own = currentSupervisorScope();
  const ref = own[0] || null;
  if(!ref){
    showModal(`<h3>Add New Pharmacist</h3>
      <p class="small-note">No existing records were found for your name in the master sheet, so District, Area Manager and City cannot be auto-filled. Please contact the training coordinator to add your region info first.</p>
      <div class="modal-actions"><button class="btn btn-outline btn-sm" onclick="closeModal()">Close</button></div>`);
    return;
  }
  showModal(`
    <h3>Add New Pharmacist</h3>
    <p class="small-note">District, Area Manager, City and Supervisor are filled in automatically from your existing records. All other fields are required, and this entry will be marked <b>Pending</b> until the trainer approves it.</p>
    <div class="field-grid">
      <div class="field"><label class="field-label">District</label><input type="text" class="locked-field" value="${esc(ref.district)}" readonly></div>
      <div class="field"><label class="field-label">Area Manager</label><input type="text" class="locked-field" value="${esc(ref.areaManager)}" readonly></div>
      <div class="field"><label class="field-label">City</label><input type="text" class="locked-field" value="${esc(ref.city)}" readonly></div>
      <div class="field"><label class="field-label">Supervisor</label><input type="text" class="locked-field" value="${esc(currentSupervisor)}" readonly></div>
    </div>
    <div class="field"><label class="field-label req">Display Name (Pharmacist Name)</label><input type="text" id="newPhName"></div>
    <div class="field-grid">
      <div class="field"><label class="field-label req">Pharmacy No.</label><input type="text" id="newPhPharmacyNo"></div>
      <div class="field"><label class="field-label req">User/Employee ID</label><input type="text" id="newPhEmpId"></div>
      <div class="field"><label class="field-label req">Username (Email)</label><input type="text" id="newPhEmail"></div>
      <div class="field"><label class="field-label req">Phone (WhatsApp)</label><input type="text" id="newPhPhone"></div>
      <div class="field"><label class="field-label req">SCFHS</label><input type="text" id="newPhScfhs"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" id="submitPhBtn" onclick="confirmAddPharmacist('${esc(ref.district)}','${esc(ref.areaManager)}','${esc(ref.city)}')">Submit for Approval</button>
    </div>`);
}
async function confirmAddPharmacist(district, areaManager, city){
  if(confirmAddPharmacist._busy) return;
  confirmAddPharmacist._busy = true;
  const btn = document.getElementById('submitPhBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Submitting…'; }
  try{
    const fields = {
      displayName: document.getElementById('newPhName').value.trim(),
      pharmacyNo: document.getElementById('newPhPharmacyNo').value.trim(),
      employeeId: document.getElementById('newPhEmpId').value.trim(),
      email: document.getElementById('newPhEmail').value.trim(),
      phone: document.getElementById('newPhPhone').value.trim(),
      scfhs: document.getElementById('newPhScfhs').value.trim()
    };
    for(const [k,v] of Object.entries(fields)){
      if(!v){
        toast('All fields are required','err');
        if(btn){ btn.disabled = false; btn.textContent = 'Submit for Approval'; }
        return;
      }
    }
    const p = {
      id: uid('ph'),
      district, areaManager, city,
      supervisor: currentSupervisor,
      ...fields,
      addedAt: nowIso(),
      status: 'Pending'
    };
    pendingList = await getShared(K_PENDING, []);
    pendingList.push(p);
    const ok = await setShared(K_PENDING, pendingList);
    closeModal();
    if(ok){ toast('Submitted — pending trainer approval','ok'); renderSupervisorChips(); renderSupervisorTable(); }
  } finally {
    confirmAddPharmacist._busy = false;
  }
}

/* ═══════════════════════════════ BULK ADD NEW PHARMACISTS (SUPERVISOR) ═══════════════════════════════ */
function openBulkAddModal(){
  const own = currentSupervisorScope();
  const ref = own[0] || null;
  showModal(`
    <h3>Bulk Add New Pharmacists</h3>
    <p class="small-note">Download the template (pre-filled with your region), add rows for each new pharmacist, then upload it back. Every row needs Display Name, Pharmacy No., Employee ID, Email, Phone and SCFHS filled in. Each one is submitted for the trainer's approval, same as adding one at a time.</p>
    <div class="row" style="margin-bottom:10px;">
      <button class="btn btn-outline btn-sm" onclick="downloadBulkAddTemplate()">⬇ Download Template</button>
    </div>
    <div class="field"><label class="field-label">Upload filled template</label><input type="file" id="bulkAddFile" accept=".xlsx,.xls,.csv"></div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" onclick="confirmBulkAddUpload('${ref?esc(ref.district):''}','${ref?esc(ref.areaManager):''}','${ref?esc(ref.city):''}')">Upload &amp; Submit</button>
    </div>`);
}
async function downloadBulkAddTemplate(){
  const own = currentSupervisorScope();
  const ref = own[0] || {district:'', areaManager:'', city:''};
  const headers = ['District','Area Manager','City','Supervisor','Display Name','Pharmacy No.','User/Employee ID','Username (Email)','Phone number (Whatsapp)','SCFHS'];
  const rows = [['(auto)','(auto)','(auto)', currentSupervisor, 'e.g. Ahmed Mohamed Ali', '123456', 'EMP001', 'a_ali@example.com', '0501234567', '1234567']];
  const colWidths = computeAutoColWidths_(headers, rows);
  await downloadStyledXlsx('new-pharmacists-template.xlsx', 'New Pharmacists', headers, rows, colWidths, {autoFilter:true});
}
async function confirmBulkAddUpload(district, areaManager, city){
  const file = document.getElementById('bulkAddFile').files[0];
  if(!file){ toast('Choose a file first','err'); return; }
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:false});
      if(aoa.length<2){ toast('No rows found in the file','err'); return; }
      const headerRow = aoa[0].map(h=>String(h||'').trim());
      const idx = {
        displayName: headerRow.findIndex(h=>/display.*name/i.test(h)),
        pharmacyNo: headerRow.findIndex(h=>/pharmacy\s*no/i.test(h)),
        employeeId: headerRow.findIndex(h=>/employee.*id/i.test(h)),
        email: headerRow.findIndex(h=>/email/i.test(h)),
        phone: headerRow.findIndex(h=>/phone/i.test(h)),
        scfhs: headerRow.findIndex(h=>/scfhs/i.test(h))
      };
      if(idx.displayName===-1){ toast('Could not find a Display Name column in this file','err'); return; }

      let submitted = 0, skipped = 0;
      pendingList = await getShared(K_PENDING, []);
      aoa.slice(1).forEach(r=>{
        const displayName = idx.displayName!==-1 ? String(r[idx.displayName]??'').trim() : '';
        const pharmacyNo = idx.pharmacyNo!==-1 ? String(r[idx.pharmacyNo]??'').trim() : '';
        const employeeId = idx.employeeId!==-1 ? String(r[idx.employeeId]??'').trim() : '';
        const email = idx.email!==-1 ? String(r[idx.email]??'').trim() : '';
        const phone = idx.phone!==-1 ? String(r[idx.phone]??'').trim() : '';
        const scfhs = idx.scfhs!==-1 ? String(r[idx.scfhs]??'').trim() : '';
        if(!displayName || displayName.toLowerCase().startsWith('e.g.')){ return; }
        if(!pharmacyNo || !employeeId || !email || !phone || !scfhs){ skipped++; return; }
        pendingList.push({
          id: uid('ph'), district, areaManager, city, supervisor: currentSupervisor,
          displayName, pharmacyNo, employeeId, email, phone, scfhs,
          addedAt: nowIso(), status: 'Pending'
        });
        submitted++;
      });
      if(!submitted){ toast('No valid rows found — every row needs all fields filled in','err'); return; }
      const ok = await setShared(K_PENDING, pendingList);
      closeModal();
      if(ok){
        toast(`Submitted ${submitted} pharmacist(s) for approval` + (skipped?`, skipped ${skipped} incomplete row(s)`:''), 'ok');
        renderSupervisorChips(); renderSupervisorTable();
      }
    }catch(err){
      console.error(err);
      toast('Error reading file: '+(err.message||''), 'err');
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ═══════════════════════════════ ANNUAL LEAVE BULK TEMPLATE (SUPERVISOR) ═══════════════════════════════ */
async function downloadAnnualLeaveTemplate(){
  const own = masterData.filter(p=>p.supervisor===currentSupervisor);
  if(!own.length){ toast('No pharmacists found for your name','err'); return; }
  const headers = ['Display Name','Email','Annual Leave (write YES)'];
  const rows = own.map(p=>[p.displayName, p.email||'', '']);
  const colWidths = computeAutoColWidths_(headers, rows);
  await downloadStyledXlsx('annual-leave-template.xlsx', 'Annual Leave', headers, rows, colWidths, {autoFilter:true});
}
function openBulkAnnualLeaveModal(){
  showModal(`
    <h3>Bulk Annual Leave</h3>
    <p class="small-note">Download the template (pre-filled with your pharmacists), write YES next to anyone on Annual Leave, then upload it back. Nothing changes until the trainer approves each one.</p>
    <div class="row" style="margin-bottom:10px;">
      <button class="btn btn-outline btn-sm" onclick="downloadAnnualLeaveTemplate()">⬇ Download Template</button>
    </div>
    <div class="field"><label class="field-label">Upload filled template</label><input type="file" id="annualLeaveFile" accept=".xlsx,.xls,.csv"></div>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-navy btn-sm" onclick="confirmAnnualLeaveUpload()">Upload &amp; Submit</button>
    </div>`);
}
async function confirmAnnualLeaveUpload(){
  const file = document.getElementById('annualLeaveFile').files[0];
  if(!file){ toast('Choose a file first','err'); return; }
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:false});
      if(aoa.length<2){ toast('No rows found in the file','err'); return; }
      const headerRow = aoa[0].map(h=>String(h||'').trim());
      const nameIdx = headerRow.findIndex(h=>/display.*name/i.test(h));
      const emailIdx = headerRow.findIndex(h=>/email/i.test(h));
      const leaveIdx = headerRow.findIndex(h=>/annual\s*leave/i.test(h));
      if(leaveIdx===-1){ toast('Could not find the Annual Leave column in this file','err'); return; }

      const own = masterData.filter(p=>p.supervisor===currentSupervisor);
      let leaveRequests = await getShared(K_LEAVE_REQUESTS, []);
      let submitted = 0, notFound = 0;
      aoa.slice(1).forEach(r=>{
        const marked = /^(yes|y|1|true)$/i.test(String(r[leaveIdx]??'').trim());
        if(!marked) return;
        const email = emailIdx!==-1 ? String(r[emailIdx]??'').trim().toLowerCase() : '';
        const name = nameIdx!==-1 ? String(r[nameIdx]??'').trim() : '';
        const match = own.find(p => (email && (p.email||'').toLowerCase()===email) || (!email && name && p.displayName===name));
        if(!match){ notFound++; return; }
        if(leaveRequests.some(lr=>lr.pharmacistId===match.id && lr.status==='Pending')) return;
        leaveRequests.push({
          id: uid('lr'), pharmacistId: match.id, displayName: match.displayName, supervisor: currentSupervisor,
          status: 'Pending', requestedAt: nowIso(), decidedAt: null
        });
        submitted++;
      });
      if(!submitted){ toast('No matching pharmacists marked YES were found'+(notFound?` (${notFound} row(s) could not be matched)`:''), 'err'); return; }
      const ok = await setShared(K_LEAVE_REQUESTS, leaveRequests);
      closeModal();
      if(ok){
        toast(`Submitted ${submitted} Annual Leave request(s) for approval`+(notFound?`, ${notFound} row(s) not matched`:''), 'ok');
      }
    }catch(err){
      console.error(err);
      toast('Error reading file: '+(err.message||''), 'err');
    }
  };
  reader.readAsArrayBuffer(file);
}

async function exportSupervisorExcel(){
  const list = applySupFilters(currentSupervisorScope());
  if(!list.length){ toast('No data to export','err'); return; }
  const headers = ['Pharmacist Name','Pharmacy No.','Email','Supervisor','District','Area Manager','City','Date','Attendance','Late Arrival Time','Work Shift','Core %','Capsule %','Notes'];
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
    rows.push([r.displayName,r.pharmacyNo,r.email,r.supervisor,r.district,r.areaManager,r.city,r.dateText,r.statusText,lateTime,r.workShift,
      courseSlotText(p,'core'),courseSlotText(p,'capsule'),r.note]);
  });
  const colWidths = [28,14,28,20,14,18,12,24,16,14,14,10,10,26];
  const ok = await downloadStyledXlsx('my-pharmacists.xlsx', 'My Pharmacists', headers, rows, colWidths);
  if(ok) toast('Excel downloaded','ok');
}


/* ═══════════════════════════════ PAGE STARTUP ═══════════════════════════════ */
window.addEventListener('DOMContentLoaded', async ()=>{
  API.init('supervisor');
  // if the server refuses a save (day full, deadline passed…) show the real state again
  APP_HOOKS.onSaveFailed = ()=>{ if(currentSupervisor) loadSupervisorView(true); };
  // the server stored a "Retraining #n" marker / attempt history for a re-booked pharmacist — show it right away
  APP_HOOKS.onOpsUpdated = (pids, historyChanged)=>{ if(currentSupervisor && historyChanged){ renderSupervisorChips(); renderSupervisorTable(); } };
  initSyncStatusIndicator();
  loadLogo();
  await initSupervisor();
});