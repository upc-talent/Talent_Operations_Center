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
    `<button class="btn btn-outline btn-sm" onclick="clearSupFilters()">Clear Filters</button>`;
}
function onSupSearch(v){ supSearchQ=v; renderSupervisorTable(); }
function clearSupFilters(){
  supFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), date:new Set() };
  supSearchQ='';
  supStatusFilter = null;
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
  if(name!==currentSupervisor) supStatusFilter = null;
  currentSupervisor = name;
  API.setSupervisor(name);
  await setPersonal('last-supervisor-name', name);
  await loadCoreData();

  document.getElementById('supMain').classList.remove('hidden');
  document.getElementById('supTitle').textContent = 'Pharmacists — ' + name;
  document.getElementById('capHintSup').textContent = trainingConfig.maxCapacity;

  updateSupTrackTabs();
  renderSupervisorChips();
  buildSupervisorFilterBar();
  renderSupervisorTable();
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

  const list = [...pendingDecided, ...quotaDecided, ...leaveDecided]
    .sort((a,b)=> new Date(b.decidedAt||0) - new Date(a.decidedAt||0));

  const rows = list.length ? list.map((r,i)=>`
    <tr>
      <td class="name-cell" style="white-space:normal;min-width:160px;"><span class="rownum">${i+1}</span>${esc(r.displayName)}</td>
      <td style="white-space:normal;"><span class="badge badge-empty">${esc(r.type)}</span></td>
      <td><span class="badge ${r.status==='Approved'?'badge-date':'badge-leave'}">${esc(r.status)}</span></td>
      <td style="white-space:normal;min-width:100px;">${esc(r.reason||'—')}</td>
      <td style="white-space:nowrap;">${r.decidedAt ? new Date(r.decidedAt).toLocaleDateString('en-GB') : '—'}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty-msg">No decisions yet</td></tr>`;
  showModal(`
    <h3>Submission History</h3>
    <p class="small-note">New pharmacists, over-quota assignments, and Annual Leave requests you've submitted, and what happened to them — these stay here permanently.</p>
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
      const msg = n.result==='Rejected' && n.reason ? `${n.pharmacistName}: Rejected — ${n.reason}` : `${n.pharmacistName}: ${n.result}`;
      toast(msg, n.result==='Approved' ? 'ok' : 'err');
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
      return `<div class="chip chip-lg ${st.cls}"><div class="lbl">${esc(dayGroupText(d))}</div><div class="num">${count} / ${cap}</div><div class="row" style="gap:5px;margin-top:5px;flex-wrap:wrap;"><span class="tag" style="margin:0;">${st.tag}</span>${quotaHtml}${deadlineHtml}</div></div>`;
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
    if(!inSet(p.district, supFilterState.district)) return false;
    if(!inSet(p.areaManager, supFilterState.areaManager)) return false;
    if(!inSet(p.city, supFilterState.city)) return false;
    if(!matchesDateSet(p.id, supFilterState.date)) return false;
    if(supSearchQ){
      const q = supSearchQ.toLowerCase();
      if(!p.displayName.toLowerCase().includes(q) && !(p.email||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function renderSupervisorTable(){
  let own = applySupFilters(currentSupervisorScope());
  // New pharmacists still awaiting approval belong to none of the status cards, so a card filter hides them.
  const pending = supStatusFilter ? [] : applySupFilters(currentSupervisorPendingScope());
  const tag = document.getElementById('supStatusTag');
  if(tag) tag.innerHTML = statusFilterTagHtml(supStatusFilter, 'setSupStatusFilter');
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
  // Column order: Pharmacist Name (with its row number), Email, Supervisor, District, Area Manager, City, Date, Attendance Status, Notes
  const nameCell = (n, p) => `<td class="name-cell"><span class="rownum">${n}</span>${esc(p.displayName)}</td>`;
  let rows = own.map(p=>{
    i++;
    // Someone who attended can't be moved to another day (or a leave status) by the supervisor — the server refuses it too.
    const dateHtml = hasAttendedTraining(p)
      ? `${dateCellHtml(p, false, days, 'onAssignChange')}<div class="locked-note" title="This pharmacist already attended the training. Only the training team can change it.">🔒 Attended — can't be reassigned</div>`
      : dateCellHtml(p, true, days, 'onAssignChange');
    return `<tr>
      ${bulkCheckboxCell('sup', p.id)}
      ${nameCell(i, p)}
      <td>${esc(p.email||'—')}</td>
      <td>${esc(p.supervisor)}</td>
      <td>${esc(p.district||'—')}</td>
      <td>${esc(p.areaManager||'—')}</td>
      <td>${cityCellHtml(p)}</td>
      <td class="no-truncate">${dateHtml}</td>
      <td class="no-truncate">${attendanceBadgeHtml(p)}</td>
      <td class="no-truncate">${p.note ? `<span class="sup-note">${esc(p.note)}</span>` : '<span class="small-note">—</span>'}</td>
    </tr>`;
  }).join('');
  rows += pending.map(p=>{
    i++;
    return `<tr class="pending-row">
      <td class="sel-cell"></td>
      ${nameCell(i, p)}
      <td>${esc(p.email||'—')}</td>
      <td>${esc(p.supervisor)}</td>
      <td>${esc(p.district||'—')}</td>
      <td>${esc(p.areaManager||'—')}</td>
      <td>${cityCellHtml(p)}</td>
      <td class="no-truncate"><span class="badge badge-pending">Pending Approval</span><br>
        <button class="btn btn-outline btn-sm" style="margin-top:4px;" onclick="openEditPendingModal('${p.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" style="margin-top:4px;" onclick="deletePendingPharmacist('${p.id}')">Delete</button>
      </td>
      <td></td>
      <td></td>
    </tr>`;
  }).join('');
  tb.innerHTML = rows;
  updateSortIndicators('sup');
  bulkSyncAfterRender('sup', own.map(p=>p.id));
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
  // pharmacists who already attended are never changed by a supervisor
  const people = selected.filter(p=>!hasAttendedTraining(p));
  const attendedSkipped = selected.length - people.length;
  if(!people.length){ toast('All selected pharmacists already attended their training — only the training team can change them.','err'); return; }
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
  toast(msg, (skipped||pending||attendedSkipped)?'info':'ok');
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
  if(person && hasAttendedTraining(person)){
    toast('This pharmacist already attended their training — only the training team can change it.','err');
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
      ops.assignments[pid] = {type:'date', dateId:rest, assignedBy:currentSupervisor, assignedAt: nowIso(), overQuota, quotaApproved: !overQuota};
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
  const headers = ['Pharmacist Name','Email','Supervisor','District','Area Manager','City','Date','Attendance','Late Arrival Time','Notes'];
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
    rows.push([r.displayName,r.email,r.supervisor,r.district,r.areaManager,r.city,r.dateText,r.statusText,lateTime,r.note]);
  });
  const colWidths = [28,28,20,14,18,12,24,16,14,26];
  const ok = await downloadStyledXlsx('my-pharmacists.xlsx', 'My Pharmacists', headers, rows, colWidths);
  if(ok) toast('Excel downloaded','ok');
}


/* ═══════════════════════════════ PAGE STARTUP ═══════════════════════════════ */
window.addEventListener('DOMContentLoaded', async ()=>{
  API.init('supervisor');
  // if the server refuses a save (day full, deadline passed…) show the real state again
  APP_HOOKS.onSaveFailed = ()=>{ if(currentSupervisor) loadSupervisorView(true); };
  initSyncStatusIndicator();
  loadLogo();
  await initSupervisor();
});