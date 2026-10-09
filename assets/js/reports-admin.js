/* ════════════════════════════════════════════════════════════════════
   Reports (v5) — staff tabs on the Admins Dashboard: Moodle Reports, SAP Reports, Reports Configuration.
   Superadmin + coordinators only (trainers never see these tabs; the server refuses them too).

   Moodle Reports is a port of the standalone "Moodle Completion Rate Tool": completion exports are read and merged
   IN THIS BROWSER, and only the computed rows are sent when the user presses Publish (coursePublish replaces the
   course's data). Differences from the original tool:
   - timestamps are read by an explicit parser (rpParseTs) as KSA time (UTC+3), not by the browser's date guesser;
     a completion whose timestamp can't be read counts as "Completed (date unknown)" — never On time / Late — and
     the preview warns about it (publishing then needs an explicit confirmation);
   - final videos, counted statuses, excluded videos and the deadline are saved on the course (when published),
     not in localStorage; the exclusion list is never saved anywhere;
   - the stat cards are computed without the excluded rows (the original counted them on screen but not in the file).
   All globals here start with "rp" to stay clear of trainer.js / common.js.
   ════════════════════════════════════════════════════════════════════ */

const RP_STATES = ['Completed','Final video done, others missing','In progress','Not started'];
const RP_SCHED = ['On time','Late','Overdue','Still within deadline','Completed (date unknown)'];
const RP_CUTS = ['Yes','No, completed later','No, not completed','Completed (date unknown)'];
const RP_MATCH_LABEL = {roster:'In roster', onboarding:'Onboarding', not_in_roster:'Not in roster', no_email:'No valid email'};
const RP_KSA_MS = 3*3600*1000;                       // KSA = UTC+3, no daylight saving
const RP_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;   // same rule as the server
const RP_MAX_ROWS_SHOWN = 2000;
const RP_MON_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const RP_MONTH_NUM = (()=>{ const o = {}; ['january','february','march','april','may','june','july','august','september','october','november','december']
  .forEach((m,i)=>{ o[m] = i+1; o[m.slice(0,3)] = i+1; }); o.sept = 9; return o; })();
const RP_DISPLAY_COLUMNS = [
  ['num','#'], ['district','District'], ['areaManager','Area Manager'], ['city','City'], ['supervisor','Supervisor'],
  ['email','Email'], ['name','Name'], ['rate','Completion rate'], ['state','State'], ['completionDate','Completion date'], ['daysLeft','Days Left']
];

const rpState = {
  inited:false, courses:[], coreCourseId:null, capsuleCourseId:null, coursesLoaded:false, courseId:'',
  files:[], fileSeq:0, model:null, done:{}, include:{}, finals:{}, res:[],
  deadline:null, cutoff:null, cutoffMode:'before', cutoffBasis:'final',
  exEmails:new Set(), exDomains:[], exItems:[],
  learners:[], learnersLoaded:false, sortKey:'rate', sortDir:-1, q:'', editingId:null
};
let rpFilterState = { state:new Set(), source:new Set(), sched:new Set(), cutoff:new Set(), match:new Set() };

/* ═══════════════════════════════ ENGINE (pure functions — see rpSelfTest) ═══════════════════════════════ */
function rpClean(s){ return String(s==null?'':s).replace(/&amp;/g,'&').replace(/\s+/g,' ').trim(); }
function rpNorm(s){ return rpClean(s).toLowerCase(); }
function rpDefaultDone(s){ return /^(complet|done|pass)/i.test(s) && !/\b(not|fail)/i.test(s); }

// A wall-clock time in KSA → epoch ms, or null when the parts don't form a real date/time.
function rpKsaEpoch(y, mo, d, h, mi, s){
  if([y,mo,d,h,mi,s].some(v=>!Number.isFinite(v))) return null;
  if(y<2000 || y>2100 || mo<1 || mo>12 || d<1 || d>31 || h<0 || h>23 || mi<0 || mi>59 || s<0 || s>59) return null;
  const t = Date.UTC(y, mo-1, d, h, mi, s);
  const c = new Date(t);
  if(c.getUTCFullYear()!==y || c.getUTCMonth()!==mo-1 || c.getUTCDate()!==d) return null;   // e.g. 31 June
  return t - RP_KSA_MS;
}
// 12-hour clock: "2" + "PM" → 14; without AM/PM the hour must be 0–23. Returns NaN when invalid.
function rpHour24(h, ap){
  if(h===undefined) return 0;
  h = Number(h);
  if(!ap) return h;
  if(h<1 || h>12) return NaN;
  return (h % 12) + (/p/i.test(ap) ? 12 : 0);
}
// Excel serial date-time (days since 1899-12-30), as shown in the sheet = KSA wall time.
function rpFromSerial(n){
  if(!(n>=36526 && n<73051)) return null;   // 2000-01-01 … 2099-12-31
  const wallMs = Math.round((n - 25569) * 86400) * 1000;
  return wallMs - RP_KSA_MS;
}
/* The completion timestamp formats we accept (all read as KSA time); anything else → null ("couldn't read"):
     2026-10-05 14:30[:00]                         YYYY-MM-DD HH:MM[:SS]   (a "T" instead of the space is fine)
     5/10/2026 [2:30[:00] [PM]]                    D/M/YYYY, day first, 12- or 24-hour time
     [Monday, ]5 October 2026[, 2:30 PM]           also "5 Oct 2026"
     46300.6                                       an Excel serial number (a cell formatted as a date)        */
function rpParseTs(v){
  if(v===null || v===undefined) return null;
  if(typeof v==='number') return rpFromSerial(v);
  const s = String(v).replace(/\s+/g,' ').trim();
  if(!s) return null;
  let m;
  if(/^\d+(\.\d+)?$/.test(s)) return rpFromSerial(Number(s));
  if((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)))
    return rpKsaEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6]||0));
  if((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,? (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AaPp]\.?[Mm]\.?))?)?$/)))
    return rpKsaEpoch(+m[3], +m[2], +m[1], rpHour24(m[4], m[7]), +(m[5]||0), +(m[6]||0));
  if((m = s.match(/^(?:[A-Za-z]+,? )?(\d{1,2}) ([A-Za-z]+)\.?,? (\d{4})(?:,? (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AaPp]\.?[Mm]\.?))?)?$/))){
    const mon = RP_MONTH_NUM[m[2].toLowerCase()];
    if(!mon) return null;
    return rpKsaEpoch(+m[3], mon, +m[1], rpHour24(m[4], m[7]), +(m[5]||0), +(m[6]||0));
  }
  return null;
}
// The timestamp exactly as written in the file (an Excel serial is kept as its number).
function rpRawText(v){ return v===null || v===undefined ? '' : (typeof v==='number' ? String(v) : rpClean(v)); }
// KSA display: "5 Oct 26" or "5 Oct 26, 14:30"
function rpFmtKsa(t, withTime){
  if(t===null || t===undefined || isNaN(t)) return '';
  const d = new Date(t + RP_KSA_MS);
  const day = `${d.getUTCDate()} ${RP_MON_SHORT[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(-2)}`;
  return withTime ? `${day}, ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}` : day;
}
function rpFmtIso(iso, withTime){ return iso ? rpFmtKsa(Date.parse(iso), withTime) : ''; }
// <input type=date/time> values (KSA) ↔ epoch
function rpEpochFromInputs(date, time, seconds){
  const m = String(date||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return null;
  const tm = String(time||'00:00').match(/^(\d{2}):(\d{2})/) || [null,'0','0'];
  return rpKsaEpoch(+m[1], +m[2], +m[3], +tm[1], +tm[2], seconds||0);
}
function rpInputsFromEpoch(t){
  const d = new Date(t + RP_KSA_MS);
  const p = n=>String(n).padStart(2,'0');
  return {date:`${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`, time:`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`};
}

/* One sheet → its activities and rows. Column A = name; the email column is the one whose header says "email"
   (else column B); every later header is a video, and an untitled column right after it holds its timestamp. */
function rpParseAoa(aoa){
  if(!aoa || !aoa.length) throw new Error('The file is empty.');
  const h = aoa[0].map(x=>rpClean(x));
  let emailCol = h.findIndex(x=>/e-?mail/i.test(x));
  if(emailCol<0) emailCol = 1;
  const acts = [];
  let c = emailCol+1;
  while(c<h.length){
    if(h[c]){
      const a = {name:h[c], key:rpNorm(h[c]), sCol:c, tCol:null};
      if(c+1<h.length && !h[c+1]){ a.tCol = c+1; c++; }
      acts.push(a);
    }
    c++;
  }
  if(!acts.length) throw new Error('No video columns found after the email column.');
  const rows = aoa.slice(1).filter(r=>rpClean(r[0]) || rpClean(r[emailCol]));
  return {acts, rows, emailCol};
}

// All loaded files → the union of videos (by name) and of students (by email; no email = a student of its own).
function rpBuildModel(files){
  const vmap = {}, acts = [];
  files.forEach(f=>f.acts.forEach(a=>{
    let v = vmap[a.key];
    if(!v){ v = vmap[a.key] = {name:a.name, key:a.key, files:[]}; acts.push(v); }
    if(v.files.indexOf(f.id)<0) v.files.push(f.id);
  }));
  const smap = {}, students = [], statuses = {};
  let rowCount = 0;
  files.forEach(f=>f.rows.forEach((r, ri)=>{
    rowCount++;
    const name = rpClean(r[0]), email = rpClean(r[f.emailCol]);
    const key = email ? 'e:'+email.toLowerCase() : 'n:'+f.id+':'+ri;
    let st = smap[key];
    if(!st){ st = smap[key] = {name, email, srcIds:[], cells:{}}; students.push(st); }
    if(!st.name && name) st.name = name;
    if(!st.email && email) st.email = email;
    if(st.srcIds.indexOf(f.id)<0) st.srcIds.push(f.id);
    f.acts.forEach(a=>{
      const sx = rpClean(r[a.sCol]) || '(blank)';
      statuses[sx] = (statuses[sx]||0)+1;
      const ts = a.tCol!=null ? r[a.tCol] : '';
      (st.cells[a.key] = st.cells[a.key] || []).push({st:sx, ts:(typeof ts==='number' ? ts : rpClean(ts)), src:f.id});
    });
  }));
  return {acts, students, statuses, rowCount};
}

function rpEntryTime(e){ if(e.t===undefined) e.t = rpParseTs(e.ts); return e.t; }
// Earliest completed entry (done in ANY sheet). An entry with a readable time beats one without.
function rpPickDone(cfg, arr){
  let pick = null, pt = null;
  arr.forEach(e=>{
    if(!cfg.done[e.st]) return;
    const t = rpEntryTime(e);
    if(pick===null || (t!==null && (pt===null || t<pt))){ pick = e; pt = t; }
  });
  return pick;
}
function rpSchedule(fDone, fAt, deadline, now){
  if(!deadline) return {s:'', t:'', c:'', days:0, rank:0};
  if(fDone){
    if(fAt===null) return {s:'Completed (date unknown)', t:'Completed (date unknown)', c:'mid', days:0, rank:2};
    if(fAt<=deadline) return {s:'On time', t:'On time', c:'ok', days:0, rank:0};
    const d = Math.ceil((fAt-deadline)/864e5);
    return {s:'Late', t:'Late by '+d+' day'+(d===1?'':'s'), c:'no', days:d, rank:3};
  }
  if(now>deadline){
    const o = Math.ceil((now-deadline)/864e5);
    return {s:'Overdue', t:'Overdue by '+o+' day'+(o===1?'':'s'), c:'no', days:o, rank:4};
  }
  return {s:'Still within deadline', t:'Still within deadline', c:'mid', days:0, rank:1};
}
function rpCutoffCheck(isDone, t, cutoff, mode){
  if(!cutoff) return {s:'', c:'', rank:0};
  if(!isDone) return {s:'No, not completed', c:'no', rank:3};
  if(t===null) return {s:'Completed (date unknown)', c:'mid', rank:2};
  const ok = mode==='before' ? t<cutoff : t<=cutoff;
  return ok ? {s:'Yes', c:'ok', rank:0} : {s:'No, completed later', c:'mid', rank:1};
}
/* Every student → done / total / rate, final video, state, schedule and cut-off. cfg = {files, model, done, include,
   finals, deadline, cutoff, cutoffMode, cutoffBasis, now, label(fileId)}. Each result also lists the completion
   timestamps it couldn't read (x.unread). */
function rpEvaluate(cfg){
  const m = cfg.model;
  const inc = m.acts.filter(a=>cfg.include[a.key]);
  return m.students.map(stu=>{
    let done = 0, latest = null, latestRaw = '';
    const missing = [], unread = [];
    inc.forEach(a=>{
      const arr = stu.cells[a.key] || [];
      arr.forEach(e=>{ if(cfg.done[e.st] && rpRawText(e.ts) && rpEntryTime(e)===null) unread.push(rpRawText(e.ts)); });
      const pick = arr.length ? rpPickDone(cfg, arr) : null;
      if(pick){
        done++;
        const t = rpEntryTime(pick);
        if(t!==null && (latest===null || t>latest)){ latest = t; latestRaw = rpRawText(pick.ts); }
      } else missing.push(a.name);
    });
    // final video: each sheet has its own; any sheet the student appears in counts
    const fEntries = [];
    cfg.files.forEach(f=>(stu.cells[cfg.finals[f.id]] || []).forEach(e=>{ if(e.src===f.id) fEntries.push(e); }));
    fEntries.forEach(e=>{ if(cfg.done[e.st] && rpRawText(e.ts) && rpEntryTime(e)===null && unread.indexOf(rpRawText(e.ts))<0) unread.push(rpRawText(e.ts)); });
    const fPick = fEntries.length ? rpPickDone(cfg, fEntries) : null;
    const fDone = !!fPick;
    const fAt = fDone ? rpEntryTime(fPick) : null;
    const fRaw = fDone ? rpRawText(fPick.ts) : '';
    const fStatus = fPick ? fPick.st : (fEntries.length ? fEntries[0].st : '(not in file)');
    const total = inc.length;
    let state;
    if(total>0 && done===total) state = 'Completed';
    else if(fDone) state = 'Final video done, others missing';
    else if(done>0) state = 'In progress';
    else state = 'Not started';
    const sc = rpSchedule(fDone, fAt, cfg.deadline, cfg.now);
    const all = cfg.cutoffBasis==='all';
    const cc = rpCutoffCheck(all ? state==='Completed' : fDone, all ? latest : fAt, cfg.cutoff, cfg.cutoffMode);
    return {
      name:stu.name, email:stu.email, srcIds:stu.srcIds, srcText:stu.srcIds.map(id=>cfg.label ? cfg.label(id) : id).join(', '),
      done, total, rate: total ? done/total*100 : 0, fDone, fStatus, fAt, fRaw, latest, latestRaw, missing, state, unread,
      sched:sc.s, sText:sc.t, sCls:sc.c, sDays:sc.days, sSort:sc.rank*100000+sc.days,
      cb:cc.s, cbCls:cc.c, cbSort:cc.rank
    };
  });
}
function rpExclusionSets(text){
  const items = String(text||'').split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
  const uniq = [...new Set(items)];
  return {items:uniq, emails:new Set(uniq.filter(x=>x.charAt(0)!=='@')), domains:uniq.filter(x=>x.charAt(0)==='@')};
}
function rpIsExcludedBy(ex, email){
  const e = String(email||'').toLowerCase().trim();
  if(!e) return false;
  if(ex.emails.has(e)) return true;
  return ex.domains.some(d=>e.length>=d.length && e.slice(e.length-d.length)===d);
}
// What a publish would store: rows that are not excluded and have a valid email.
function rpPublishable(res){ return res.filter(x=>!x.excluded && RP_EMAIL_RE.test(String(x.email||'').trim())); }

/* ═══════════════════════════════ COURSES (shared by the three tabs) ═══════════════════════════════ */
async function rpLoadCourses(force){
  if(rpState.coursesLoaded && !force) return;
  try{
    const out = await API.call('coursesList');
    rpState.courses = out.courses || [];
    rpState.coreCourseId = out.coreCourseId || null;
    rpState.capsuleCourseId = out.capsuleCourseId || null;
    rpState.coursesLoaded = true;
  }catch(e){ toast('Could not load the tracked courses — '+(e.message||'please try again'),'err'); return; }
  rpRenderCourseSelect();
  rpRenderCourseInfo();
  rpRenderCoursesTable();
  rpRenderSlots();
  rpRenderSapList();
}
function rpCourse(id){ return rpState.courses.find(c=>c.id===id) || null; }
function rpCurrentCourse(){ return rpCourse(rpState.courseId); }
function rpCourseTitle(c){ return c ? (c.displayName || c.name) : ''; }
function rpAgo(iso){
  if(!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso))/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.round(s/60)+' min ago';
  if(s<86400) return Math.round(s/3600)+' h ago';
  const d = Math.round(s/86400);
  return d+' day'+(d===1?'':'s')+' ago';
}

/* ═══════════════════════════════ MOODLE REPORTS TAB ═══════════════════════════════ */
function rpInitMoodle(){
  if(rpState.inited) return;
  rpState.inited = true;
  registerFilterScope('rp', ()=>rpFilterState, rpRenderBody);
  registerFilterFacets('rp', { items: ()=>rpState.res, values: {
    state: x=>[x.state], source: x=>x.srcIds, sched: x=>[x.sched], cutoff: x=>[x.cb], match: x=>[x.match]
  }});
  const drop = document.getElementById('rpDrop'), fileIn = document.getElementById('rpFile');
  drop.addEventListener('click', ()=>fileIn.click());
  drop.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); fileIn.click(); } });
  ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e=>{ if(e.dataTransfer && e.dataTransfer.files.length) rpAddFiles(e.dataTransfer.files); });
  fileIn.addEventListener('change', ()=>{ const arr = [...fileIn.files]; fileIn.value = ''; rpAddFiles(arr); });
  document.getElementById('rpFileList').addEventListener('input', e=>{
    const id = e.target.getAttribute && e.target.getAttribute('data-id');
    const f = id && rpState.files.find(x=>x.id===id);
    if(!f) return;
    f.label = e.target.value;
    rpBuildFinalSels();
    if(rpState.model) rpRecompute();
  });
}
async function rpOpenMoodleTab(){
  rpInitMoodle();
  await rpLoadCourses();
  if(!rpState.learnersLoaded) rpLoadLearners(true);
}
function rpRenderCourseSelect(){
  const sel = document.getElementById('rpCourse');
  if(!sel) return;
  const list = rpState.courses.filter(c=>c.source==='moodle');
  if(rpState.courseId && !list.some(c=>c.id===rpState.courseId)) rpState.courseId = '';
  sel.innerHTML = list.length
    ? `<option value="">— choose a course —</option>` + list.map(c=>`<option value="${esc(c.id)}" ${c.id===rpState.courseId?'selected':''}>${esc(rpCourseTitle(c))}${c.active?'':' (not on the public page)'}</option>`).join('')
    : `<option value="">— No Moodle course is tracked yet —</option>`;
}
function rpRenderCourseInfo(){
  const el = document.getElementById('rpCourseInfo');
  if(!el) return;
  const c = rpCurrentCourse();
  if(!c){ el.innerHTML = 'Choose the course these files belong to. Its saved final videos, counted statuses and deadline are applied automatically.'; return; }
  el.innerHTML = c.lastPublishedAt
    ? `Last published <b>${esc(rpFmtIso(c.lastPublishedAt, true))}</b> (${esc(rpAgo(c.lastPublishedAt))}) by ${esc(c.lastPublishedBy||'—')} · ${c.rowCount} row(s) · deadline ${c.deadline ? esc(rpFmtIso(c.deadline, true))+' KSA' : 'not set'}`
    : `Not published yet${c.deadline ? ' · deadline '+esc(rpFmtIso(c.deadline, true))+' KSA' : ''}.`;
}
function rpOnCourseChange(){
  rpState.courseId = document.getElementById('rpCourse').value;
  rpClearExclusions(true);   // the exclusion list never carries over to another course
  const c = rpCurrentCourse();
  const dl = c && c.deadline ? rpInputsFromEpoch(Date.parse(c.deadline)) : null;
  document.getElementById('rpDlDate').value = dl ? dl.date : '';
  document.getElementById('rpDlTime').value = dl ? dl.time : '23:59';
  rpReadDeadline();
  rpRenderCourseInfo();
  if(rpState.model){ rpApplyEngine(true); rpBuildSettingsUI(); rpRecompute(); }
}
function rpGoTrackNew(){
  switchTrainerTab('t-repconf');
  rpEditCourse(null);
  setTimeout(()=>{ const n = document.getElementById('rpCfgName'); if(n) n.focus(); }, 50);
}

/* ---------- 1. upload ---------- */
function rpShowErr(msg){ const e = document.getElementById('rpErr'); e.textContent = msg; e.classList.toggle('hidden', !msg); }
async function rpReadSheetAoa(file){
  const buf = await file.arrayBuffer();
  // raw: CSV text stays text (no locale date guessing); cell values stay raw (an Excel date is its serial number)
  const wb = XLSX.read(new Uint8Array(buf), {type:'array', cellDates:false, raw:true});
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:'', blankrows:false});
}
async function rpAddFiles(list){
  const arr = [...(list||[])];
  if(!arr.length) return;
  if(typeof XLSX==='undefined'){ toast('The Excel reader failed to load — reload the page','err'); return; }
  rpShowErr('');
  const errs = [];
  const parsed = await Promise.all(arr.map(async f=>{
    const sig = f.name+'|'+f.size+'|'+f.lastModified;
    if(rpState.files.some(x=>x.sig===sig)) return null;   // the same file twice is skipped
    try{
      const p = rpParseAoa(await rpReadSheetAoa(f));
      return Object.assign(p, {sig, fileName:f.name, id:'f'+(++rpState.fileSeq), label:f.name.replace(/\.[^.]+$/,'')});
    }catch(e){ errs.push(f.name+': '+(e.message||'could not be read')); return null; }
  }));
  parsed.forEach(p=>{ if(p) rpState.files.push(p); });
  if(errs.length) rpShowErr(errs.join(' | '));
  rpRebuild();
}
function rpRemoveFile(id){
  rpState.files = id==='*' ? [] : rpState.files.filter(f=>f.id!==id);
  rpShowErr('');
  rpRebuild();
}
function rpRenderFileList(){
  document.getElementById('rpFileList').innerHTML = rpState.files.map(f=>
    `<div class="rp-frow"><input type="text" data-id="${f.id}" value="${esc(f.label)}" aria-label="Platform name">
      <span class="small-note">${esc(f.fileName)} · ${f.rows.length} rows · ${f.acts.length} videos</span>
      <button type="button" class="btn btn-outline btn-sm" onclick="rpRemoveFile('${f.id}')">Remove</button></div>`).join('')
    + (rpState.files.length>1 ? `<div><button type="button" class="btn btn-outline btn-sm" onclick="rpRemoveFile('*')">Remove all</button></div>` : '');
}
function rpLabelOf(id){ const f = rpState.files.find(x=>x.id===id); return f ? (f.label || f.fileName) : ''; }

/* ---------- merge + the saved course settings ---------- */
function rpEngine(){ const c = rpCurrentCourse(); return (c && c.engine) || {}; }
function rpEngineDone(k){
  const acc = (rpEngine().acceptedStatuses||[]).map(rpNorm);
  return acc.length ? acc.indexOf(rpNorm(k))>-1 : rpDefaultDone(k);
}
function rpEngineInclude(key){ return (rpEngine().excludedVideos||[]).map(rpNorm).indexOf(key)<0; }
function rpEngineFinal(f){
  const saved = (rpEngine().finalVideos||[]).map(rpNorm);
  for(const k of saved){ if(f.acts.some(a=>a.key===k)) return k; }
  return f.acts[f.acts.length-1].key;
}
// fresh = true (course changed): use the course's saved settings; otherwise keep the choices made in this session
function rpApplyEngine(fresh){
  const m = rpState.model;
  const oldDone = fresh ? {} : rpState.done, oldInc = fresh ? {} : rpState.include, oldFin = fresh ? {} : rpState.finals;
  rpState.done = {}; rpState.include = {}; rpState.finals = {};
  Object.keys(m.statuses).forEach(k=>{ rpState.done[k] = (k in oldDone) ? oldDone[k] : rpEngineDone(k); });
  m.acts.forEach(a=>{ rpState.include[a.key] = (a.key in oldInc) ? oldInc[a.key] : rpEngineInclude(a.key); });
  rpState.files.forEach(f=>{
    const k = oldFin[f.id];
    rpState.finals[f.id] = (k && f.acts.some(a=>a.key===k)) ? k : rpEngineFinal(f);
  });
}
function rpRebuild(){
  rpRenderFileList();
  const has = rpState.files.length>0;
  document.getElementById('rpApp').classList.toggle('hidden', !has);
  document.getElementById('rpPreview').classList.toggle('hidden', !has);
  if(!has){
    rpState.model = null; rpState.res = [];
    document.getElementById('rpMergeNote').classList.add('hidden');
    return;
  }
  rpState.model = rpBuildModel(rpState.files);
  rpApplyEngine(false);
  rpUpdateMergeNote();
  rpBuildSettingsUI();
  rpRecompute();
}
function rpUpdateMergeNote(){
  const n = document.getElementById('rpMergeNote'), m = rpState.model;
  if(rpState.files.length<2){ n.classList.add('hidden'); return; }
  const multi = m.students.filter(x=>x.srcIds.length>1).length;
  const partial = m.acts.filter(a=>a.files.length<rpState.files.length);
  let msg = `2. Merged ${rpState.files.length} sheets: ${m.rowCount} rows became ${m.students.length} students (${multi} appear in more than one sheet). A video counts as completed if it is completed in any sheet, using the earliest timestamp.`;
  if(partial.length) msg += ` ${partial.length} video(s) are not in every sheet: ${partial.slice(0,5).map(a=>'"'+a.name+'"').join(', ')}${partial.length>5?', …':''}. If these should be the same video, check that the names match exactly.`;
  n.textContent = msg;
  n.classList.remove('hidden');
  n.classList.toggle('warn', partial.length>0);
}

/* ---------- 3–4. final videos, statuses, included videos ---------- */
function rpBuildSettingsUI(){ rpBuildFinalSels(); rpUpdateFinalNote(); rpBuildChips(); rpBuildVids(); }
function rpBuildFinalSels(){
  const multi = rpState.files.length>1;
  document.getElementById('rpFinalSels').innerHTML = rpState.files.map(f=>
    `<label class="rp-field"><span class="field-label">${multi ? 'Final video — '+esc(f.label||f.fileName) : 'Final video'}</span>
      <select onchange="rpOnFinalChange('${f.id}', this.value)">${f.acts.map((a,i)=>`<option value="${esc(a.key)}" ${rpState.finals[f.id]===a.key?'selected':''}>${i+1}. ${esc(a.name)}</option>`).join('')}</select></label>`).join('');
  document.getElementById('rpFinalSame').classList.toggle('hidden', !multi);
}
function rpOnFinalChange(fid, key){ rpState.finals[fid] = key; rpUpdateFinalNote(); rpRecompute(); }
function rpFinalSameAll(){
  const k = rpState.finals[rpState.files[0].id];
  rpState.files.forEach(f=>{ if(f.acts.some(a=>a.key===k)) rpState.finals[f.id] = k; });
  rpBuildFinalSels(); rpUpdateFinalNote(); rpRecompute();
}
function rpFinalOf(f){ return f.acts.find(a=>a.key===rpState.finals[f.id]) || f.acts[f.acts.length-1]; }
function rpUpdateFinalNote(){
  const n = document.getElementById('rpFinalNote');
  let msg = '', warn = false;
  if(rpState.files.length===1){
    const f = rpState.files[0], cur = rpFinalOf(f), last = f.acts[f.acts.length-1];
    if(last.key!==cur.key){ msg = `In this file the last column is "${last.name}", but the final video "${cur.name}" is at position ${f.acts.indexOf(cur)+1} of ${f.acts.length}.`; warn = true; }
    else msg = `The final video is the last column in this file: "${cur.name}".`;
  } else {
    const notLast = rpState.files.filter(f=>rpFinalOf(f).key!==f.acts[f.acts.length-1].key)
      .map(f=>`${f.label||f.fileName} (its last column is "${f.acts[f.acts.length-1].name}")`);
    msg = 'Each sheet uses its own final video; a student is finished when they complete the final video of any sheet they appear in (earliest timestamp).';
    if(notLast.length){ msg += ' Not the last column in: '+notLast.join('; ')+'.'; warn = true; }
  }
  n.textContent = msg;
  n.classList.remove('hidden');
  n.classList.toggle('warn', warn);
}
function rpBuildChips(){
  const st = rpState.model.statuses;
  const keys = Object.keys(st).sort((a,b)=>st[b]-st[a]);
  document.getElementById('rpChips').innerHTML = keys.map((k,i)=>
    `<label class="rp-chip${rpState.done[k]?' on':''}"><input type="checkbox" data-i="${i}" ${rpState.done[k]?'checked':''} onchange="rpOnChip(this)">${esc(k)} <span class="n">${st[k]}</span></label>`).join('');
  rpState._chipKeys = keys;
}
function rpOnChip(cb){
  const k = rpState._chipKeys[+cb.getAttribute('data-i')];
  rpState.done[k] = cb.checked;
  cb.parentNode.classList.toggle('on', cb.checked);
  rpRecompute();
}
function rpBuildVids(){
  const m = rpState.model, nf = rpState.files.length;
  document.getElementById('rpVids').innerHTML = m.acts.map((a,i)=>{
    const cov = nf>1 ? ` <span class="rp-cov${a.files.length<nf?' part':''}">${a.files.length}/${nf} sheets</span>` : '';
    return `<label><input type="checkbox" data-i="${i}" ${rpState.include[a.key]?'checked':''} onchange="rpOnVid(this)"><span>${esc(a.name)}${cov}</span></label>`;
  }).join('');
}
function rpOnVid(cb){ rpState.include[rpState.model.acts[+cb.getAttribute('data-i')].key] = cb.checked; rpRecompute(); }
function rpSetAllVids(v){
  rpState.model.acts.forEach(a=>{ rpState.include[a.key] = v; });
  document.querySelectorAll('#rpVids input').forEach(cb=>{ cb.checked = v; });
  rpRecompute();
}

/* ---------- 5. deadline · 6. cut-off ---------- */
function rpReadDeadline(){
  const d = document.getElementById('rpDlDate').value, t = document.getElementById('rpDlTime').value || '23:59';
  // inclusive minute: 23:59 means up to 23:59:59 KSA
  rpState.deadline = d ? rpEpochFromInputs(d, t, 59) : null;
  const n = document.getElementById('rpDlNote');
  if(rpState.deadline){ n.textContent = `Deadline: ${d} ${t}:59 KSA (UTC+3). Saved to the course when you publish.`; n.classList.remove('hidden'); }
  else n.classList.add('hidden');
  if(!rpState.deadline) rpFilterState.sched.clear();
}
function rpOnDeadlineChange(){ rpReadDeadline(); if(rpState.model) rpRecompute(); }
function rpClearDeadline(){ document.getElementById('rpDlDate').value = ''; document.getElementById('rpDlTime').value = '23:59'; rpOnDeadlineChange(); }
function rpCutoffLabel(){ return (rpState.cutoffMode==='before' ? 'before ' : 'on or before ')+document.getElementById('rpCbDate').value; }
function rpReadCutoff(){
  const d = document.getElementById('rpCbDate').value;
  rpState.cutoffMode = document.getElementById('rpCbMode').value;
  rpState.cutoffBasis = document.getElementById('rpCbBasis').value;
  rpState.cutoff = d ? (rpState.cutoffMode==='before' ? rpEpochFromInputs(d, '00:00', 0) : rpEpochFromInputs(d, '23:59', 59)) : null;
  const n = document.getElementById('rpCbNote');
  if(rpState.cutoff){
    n.textContent = `Checking who completed ${rpState.cutoffBasis==='all' ? 'every included video' : 'the final video'} ${rpCutoffLabel()} (KSA). Session only — not published.`;
    n.classList.remove('hidden');
  } else { n.classList.add('hidden'); rpFilterState.cutoff.clear(); }
}
function rpOnCutoffChange(){ rpReadCutoff(); if(rpState.model) rpRecompute(); }
function rpClearCutoff(){ document.getElementById('rpCbDate').value = ''; rpOnCutoffChange(); }

/* ---------- 7. exclusions (never stored) ---------- */
function rpReadExclusions(){
  const ex = rpExclusionSets(document.getElementById('rpExText').value);
  rpState.exItems = ex.items; rpState.exEmails = ex.emails; rpState.exDomains = ex.domains;
}
function rpIsExcluded(email){ return rpIsExcludedBy({emails:rpState.exEmails, domains:rpState.exDomains}, email); }
function rpOnExclusionInput(){
  rpReadExclusions();
  if(!rpState.res.length) return;
  rpState.res.forEach(x=>{ x.excluded = rpIsExcluded(x.email); });
  rpRenderStats(); rpRenderUnreadable(); rpRenderBody(); rpUpdateExNote();
}
function rpClearExclusions(silent){
  document.getElementById('rpExText').value = '';
  document.getElementById('rpExUpMsg').classList.add('hidden');
  if(silent){ rpReadExclusions(); rpState.res.forEach(x=>{ x.excluded = false; }); document.getElementById('rpExNote').classList.add('hidden'); return; }
  rpOnExclusionInput();
}
function rpUpdateExNote(){
  const n = document.getElementById('rpExNote');
  if(!rpState.exItems.length){ n.classList.add('hidden'); return; }
  const hidden = rpState.res.filter(x=>x.excluded).length;
  const have = new Set(rpState.res.map(x=>String(x.email||'').toLowerCase()).filter(Boolean));
  const unknown = rpState.exItems.filter(x=>x.charAt(0)!=='@' && !have.has(x));
  let msg = `${hidden} student(s) in the loaded data will be left out of the publish and the Excel.`;
  if(unknown.length) msg += ` ${unknown.length} excluded entr${unknown.length===1?'y was':'ies were'} not found in the loaded data: ${unknown.slice(0,5).join(', ')}${unknown.length>5?' …':''}. Check for typos.`;
  n.textContent = msg;
  n.classList.remove('hidden');
  n.classList.toggle('warn', unknown.length>0);
}
async function rpOnExclusionFile(input){
  const f = input.files[0];
  input.value = '';
  if(!f) return;
  const msg = document.getElementById('rpExUpMsg');
  try{
    const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), {type:'array', raw:true});
    const found = new Set();
    wb.SheetNames.forEach(name=>{
      XLSX.utils.sheet_to_json(wb.Sheets[name], {header:1, raw:false, defval:'', blankrows:false}).forEach(row=>row.forEach(cell=>{
        const t = String(cell||'').trim();
        if(!t) return;
        if(/^@[^\s@,;]+\.[^\s@,;]+$/.test(t)){ found.add(t.toLowerCase()); return; }
        (t.match(/[^\s,;<>"'()\[\]]+@[^\s,;<>"'()\[\]]+\.[^\s,;<>"'()\[\]]+/g) || []).forEach(e=>found.add(e.toLowerCase()));
      }));
    });
    if(!found.size){ msg.textContent = `No email addresses were found in "${f.name}".`; msg.classList.remove('hidden'); msg.classList.add('warn'); return; }
    const before = new Set(rpState.exItems);
    const added = [...found].filter(x=>!before.has(x));
    document.getElementById('rpExText').value = rpState.exItems.concat(added).join('\n');
    rpOnExclusionInput();
    msg.textContent = `Added ${added.length} entr${added.length===1?'y':'ies'} from "${f.name}"${found.size-added.length ? ' ('+(found.size-added.length)+' already in the list)' : ''}. Not saved — the list is cleared when the page reloads.`;
    msg.classList.remove('hidden'); msg.classList.remove('warn');
  }catch(e){ msg.textContent = `Could not read "${f.name}": ${e.message||'unknown error'}`; msg.classList.remove('hidden'); msg.classList.add('warn'); }
}

/* ---------- roster match (pharmacists roster wins, then onboarding learners) ---------- */
function rpMatchMaps(){
  const roster = new Map(), learners = new Map();
  (masterData||[]).forEach(p=>{ const e = String(p.email||'').trim().toLowerCase(); if(e && !roster.has(e)) roster.set(e, p); });
  (rpState.learners||[]).forEach(l=>learners.set(l.email, l));
  return {roster, learners};
}
function rpMatchOf(maps, email){
  const e = String(email||'').trim().toLowerCase();
  if(!RP_EMAIL_RE.test(e)) return 'no_email';
  if(maps.roster.has(e)) return 'roster';
  if(maps.learners.has(e)) return 'onboarding';
  return 'not_in_roster';
}

/* ---------- 9. compute + preview ---------- */
function rpConfig(){
  return { files:rpState.files, model:rpState.model, done:rpState.done, include:rpState.include, finals:rpState.finals,
    deadline:rpState.deadline, cutoff:rpState.cutoff, cutoffMode:rpState.cutoffMode, cutoffBasis:rpState.cutoffBasis,
    now:Date.now(), label:rpLabelOf };
}
function rpRecompute(){
  if(!rpState.model) return;
  const inc = rpState.model.acts.filter(a=>rpState.include[a.key]).length;
  document.getElementById('rpIncCount').textContent = inc+' of '+rpState.model.acts.length;
  rpState.res = rpEvaluate(rpConfig());
  const maps = rpMatchMaps();
  rpState.res.forEach(x=>{ x.match = rpMatchOf(maps, x.email); x.excluded = rpIsExcluded(x.email); });
  if(rpState.files.length<2) rpFilterState.source.clear();
  rpRenderStats();
  rpRenderUnreadable();
  rpBuildFilterBar();
  rpRenderHead();
  rpRenderBody();
  rpUpdateExNote();
}
function rpUnreadableOf(rows){
  let count = 0; const examples = [];
  rows.forEach(x=>x.unread.forEach(v=>{ count++; if(examples.length<6 && examples.indexOf(v)<0) examples.push(v); }));
  return {count, examples};
}
function rpRenderUnreadable(){
  const el = document.getElementById('rpUnreadable');
  const u = rpUnreadableOf(rpState.res.filter(x=>!x.excluded));
  if(!u.count){ el.classList.add('hidden'); return; }
  el.innerHTML = `⚠️ <b>${u.count} completion timestamp(s) couldn't be read</b> — for example: ${u.examples.map(v=>'<code>'+esc(v)+'</code>').join(', ')}.
    Those completions still count as completed, but as <b>"Completed (date unknown)"</b> — never On time or Late. Publishing will ask you to confirm.
    <span class="small-note">Accepted formats (KSA time): 2026-10-05 14:30 · 5/10/2026 2:30 PM (day first) · Monday, 5 October 2026, 2:30 PM · an Excel date.</span>`;
  el.classList.remove('hidden');
}
function rpRenderStats(){
  const rows = rpState.res.filter(x=>!x.excluded);   // the stats describe what would be published / exported
  const n = rows.length, pct = v=>v+' ('+(n?(v/n*100).toFixed(1):0)+'%)';
  let full = 0, fin = 0, sum = 0;
  rows.forEach(x=>{ if(x.state==='Completed') full++; if(x.fDone) fin++; sum += x.rate; });
  const items = [
    [n, rpState.files.length>1 ? 'Students (merged)' : 'Students in file'],
    [(n?sum/n:0).toFixed(1)+'%', 'Average completion rate'],
    [pct(full), 'Completed every included video'],
    [pct(fin), 'Finished the final video']
  ];
  if(rpState.files.length>1) items.push([rows.filter(x=>x.srcIds.length>1).length, 'Found in more than one sheet']);
  if(rpState.deadline){
    const c = s=>rows.filter(x=>x.sched===s).length;
    items.push([pct(c('On time')),'Finished on time'], [pct(c('Late')),'Finished late'], [pct(c('Overdue')),'Overdue, not finished']);
  }
  if(rpState.cutoff) items.push([pct(rows.filter(x=>x.cb==='Yes').length), 'Completed '+rpCutoffLabel()]);
  const m = k=>rows.filter(x=>x.match===k).length;
  items.push([m('roster'),'Matched to roster'], [m('onboarding'),'Onboarding learners'], [m('not_in_roster'),'Not in roster']);
  if(m('no_email')) items.push([m('no_email'),'No valid email (not published)']);
  const excl = rpState.res.length - n;
  if(excl) items.push([excl, 'Excluded from publish']);
  document.getElementById('rpStats').innerHTML = items.map(i=>`<div class="rp-stat"><div class="v">${esc(i[0])}</div><div class="l">${esc(i[1])}</div></div>`).join('');
}
function rpBuildFilterBar(){
  const opts = list=>list.map(v=>({value:v, text:v}));
  let html = `<div class="filter-field search-field"><div class="search-box"><span>🔍</span><input type="text" class="big-search-input" id="rpSearch" value="${esc(rpState.q)}" oninput="rpState.q=this.value; rpRenderBody()" placeholder="Search name or email..."></div></div>`
    + renderMsFilter('rp','state','State', opts(RP_STATES));
  if(rpState.files.length>1) html += renderMsFilter('rp','source','Source', rpState.files.map(f=>({value:f.id, text:f.label||f.fileName})));
  if(rpState.deadline) html += renderMsFilter('rp','sched','Schedule', opts(RP_SCHED));
  if(rpState.cutoff) html += renderMsFilter('rp','cutoff','Cut-off', opts(RP_CUTS));
  html += renderMsFilter('rp','match','Roster match', Object.keys(RP_MATCH_LABEL).map(k=>({value:k, text:RP_MATCH_LABEL[k]})))
    + `<button class="btn btn-outline btn-sm" onclick="rpClearFilters()">Clear Filters</button>`;
  document.getElementById('rpFilterBar').innerHTML = html;
}
function rpClearFilters(){
  rpFilterState = { state:new Set(), source:new Set(), sched:new Set(), cutoff:new Set(), match:new Set() };
  rpState.q = '';
  rpBuildFilterBar();
  rpRenderBody();
}
function rpCols(){
  const c = [{k:'name',l:'Name'},{k:'email',l:'Email'}];
  if(rpState.files.length>1) c.push({k:'srcText',l:'Source'});
  c.push({k:'done',l:'Videos done'},{k:'rate',l:'Completion rate'},{k:'fAt',l:'Final video completed at'},{k:'state',l:'State'});
  if(rpState.deadline) c.push({k:'sSort',l:'Schedule'});
  if(rpState.cutoff) c.push({k:'cbSort',l:'Completed '+rpCutoffLabel()});
  c.push({k:'match',l:'Roster match'});
  return c;
}
function rpRenderHead(){
  document.getElementById('rpThead').innerHTML = rpCols().map(c=>{
    const ar = rpState.sortKey===c.k ? (rpState.sortDir>0 ? ' ▲' : ' ▼') : '';
    return `<th onclick="rpSortBy('${c.k}')">${esc(c.l)}<span class="sort-ind">${ar}</span></th>`;
  }).join('');
}
function rpSortBy(k){
  if(rpState.sortKey===k) rpState.sortDir *= -1;
  else { rpState.sortKey = k; rpState.sortDir = (k==='rate' || k==='done') ? -1 : 1; }
  rpRenderHead(); rpRenderBody();
}
function rpView(){
  const q = rpNorm(rpState.q), fs = rpFilterState;
  const out = rpState.res.filter(x=>
    (!q || rpNorm(x.name).indexOf(q)>-1 || rpNorm(x.email).indexOf(q)>-1)
    && inSet(x.state, fs.state) && inSet(x.sched, fs.sched) && inSet(x.cb, fs.cutoff) && inSet(x.match, fs.match)
    && (!fs.source.size || x.srcIds.some(id=>fs.source.has(id))));
  let k = rpState.sortKey; const d = rpState.sortDir;
  if((k==='sSort' && !rpState.deadline) || (k==='cbSort' && !rpState.cutoff)) k = 'rate';
  return out.sort((a,b)=>{
    if(k==='fAt'){   // no date always at the bottom
      if(a.fAt===null && b.fAt===null) return 0;
      if(a.fAt===null) return 1;
      if(b.fAt===null) return -1;
      return (a.fAt-b.fAt)*d;
    }
    const av = a[k], bv = b[k];
    if(typeof av==='string' || typeof bv==='string') return String(av||'').localeCompare(String(bv||''))*d;
    return ((av||0)-(bv||0))*d;
  });
}
function rpFinalCellHtml(x){
  if(!x.fDone) return '<span class="small-note">–</span>';
  if(x.fAt!==null) return esc(rpFmtKsa(x.fAt, true));
  return x.fRaw ? `<span class="rp-tag mid" title="This timestamp couldn't be read: ${esc(x.fRaw)}">(unreadable date)</span>` : '<span class="small-note">(no date)</span>';
}
function rpRenderBody(){
  const rows = rpView();
  const shown = rows.slice(0, RP_MAX_ROWS_SHOWN);
  const cls = s=> s==='Completed' ? 'ok' : (s==='Not started' ? 'no' : 'mid');
  const mcls = {roster:'ok', onboarding:'mid', not_in_roster:'grey', no_email:'no'};
  document.getElementById('rpTbody').innerHTML = shown.length ? shown.map(x=>{
    const tip = x.missing.length ? ` title="Missing: ${esc(x.missing.join(' | '))}"` : '';
    return `<tr class="${x.excluded?'rp-excl':''}">
      <td class="name-cell">${esc(x.name)}</td>
      <td class="email-cell">${esc(x.email)}${x.excluded?' <span class="rp-tag no">excluded from publish</span>':''}</td>
      ${rpState.files.length>1 ? `<td>${esc(x.srcText)}</td>` : ''}
      <td${tip}>${x.done} / ${x.total}</td>
      <td><span class="rp-bar"><i style="width:${x.rate.toFixed(1)}%"></i></span>${x.rate.toFixed(1)}%</td>
      <td>${rpFinalCellHtml(x)}</td>
      <td><span class="rp-tag ${cls(x.state)}">${esc(x.state)}</span></td>
      ${rpState.deadline ? `<td><span class="rp-tag ${x.sCls}">${esc(x.sText)}</span></td>` : ''}
      ${rpState.cutoff ? `<td><span class="rp-tag ${x.cbCls}">${esc(x.cb)}</span></td>` : ''}
      <td><span class="rp-tag ${mcls[x.match]||''}">${esc(RP_MATCH_LABEL[x.match]||'')}</span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="${rpCols().length}" class="empty-msg">No students match</td></tr>`;
  document.getElementById('rpShowNote').textContent = rows.length>shown.length
    ? `Showing the first ${shown.length} of ${rows.length} — use search or filters to narrow it down.`
    : `${rows.length} student(s) shown`;
  const wrap = document.querySelector('#rpTableCard .table-wrap');
  if(wrap){ attachFloatingScrollbar(wrap); updateFloatingScrollbar(wrap); }
}

/* ---------- 10. local Excel + publish ---------- */
function rpSettingsRows(){
  const s = rpState, inc = s.model.acts.filter(a=>s.include[a.key]);
  const info = [['Source files', s.files.map(f=>`${f.label} (${f.fileName}, ${f.rows.length} rows)`).join(' | ')]];
  s.files.forEach(f=>info.push(['Final video'+(s.files.length>1 ? ' ('+f.label+')' : ''), rpFinalOf(f).name]));
  info.push(['Videos included in rate', inc.length+' of '+s.model.acts.length]);
  info.push(['Statuses counted as completed', Object.keys(s.done).filter(k=>s.done[k]).join(' | ')]);
  info.push(['Statuses NOT counted', Object.keys(s.done).filter(k=>!s.done[k]).join(' | ')]);
  if(s.deadline) info.push(['Deadline', document.getElementById('rpDlDate').value+' '+(document.getElementById('rpDlTime').value||'23:59')+':59 KSA (UTC+3)']);
  if(s.cutoff) info.push(['Cut-off check', 'Completed '+rpCutoffLabel()+' KSA ('+(s.cutoffBasis==='all'?'every included video completed':'final video completed')+')']);
  info.push(['Times', 'Timestamps are read as KSA time (UTC+3). Unreadable timestamps count as "Completed (date unknown)".']);
  if(s.files.length>1) info.push(['Merge rule', 'Students matched by email. A video counts as completed if completed in any sheet; the earliest completion timestamp is used. Each sheet has its own final video; a student is finished when they complete the final video of any sheet they appear in.']);
  return info;
}
async function rpDownloadExcel(){
  if(!rpState.model){ toast('Upload a completion sheet first','err'); return; }
  const list = rpView().filter(x=>!x.excluded);
  if(!list.length){ toast('Nothing to download: every student in the current view is excluded or filtered out','err'); return; }
  const multi = rpState.files.length>1, dl = !!rpState.deadline, cut = !!rpState.cutoff;
  const headers = ['Name','Email'].concat(multi?['Source']:[], ['Roster match','Videos completed','Total videos','Completion rate %','Final video status',
    'Final video completed at','Latest completion (any video)','State'], dl?['Deadline','Schedule','Days late / overdue']:[], cut?['Cut-off','Completed by cut-off']:[]);
  const dlText = dl ? rpFmtKsa(rpState.deadline, true)+' KSA' : '';
  const rows = list.map(x=>[x.name, x.email].concat(multi?[x.srcText]:[], [
    RP_MATCH_LABEL[x.match]||'', x.done, x.total, Math.round(x.rate*10)/10, x.fStatus,
    x.fDone ? (x.fAt!==null ? rpFmtKsa(x.fAt, true) : (x.fRaw ? 'Unreadable: '+x.fRaw : '(no date)')) : '',
    x.latest!==null ? rpFmtKsa(x.latest, true) : '', x.state],
    dl?[dlText, x.sText, x.sDays||'']:[], cut?['Completed '+rpCutoffLabel(), x.cb]:[]));
  const stateIdx = headers.indexOf('State'), matchIdx = headers.indexOf('Roster match');
  const c = rpCurrentCourse();
  const name = reportFileName(c ? rpCourseTitle(c) : (rpState.files.length===1 ? rpState.files[0].label : 'Moodle completion'), 'moodle', 'xlsx');
  const ok = await downloadStyledXlsx(name, 'Completion', headers, rows, null, {autoName:true, sheets:[
    {name:'Completion', headers, rows, opts:{autoFilter:true, statusCols:[stateIdx, matchIdx]}},
    {name:'Settings used', headers:['Setting','Value'], rows:rpSettingsRows(), colWidths:[34,100]}
  ]});
  if(ok) toast('Excel downloaded — '+name,'ok');
}
function rpPublishPayload(c){
  const s = rpState;
  const base = s.res.filter(x=>!x.excluded);
  const pub = rpPublishable(s.res);
  const iso = t=>t===null||t===undefined ? null : new Date(t).toISOString();
  const rows = pub.map(x=>({
    email:String(x.email).trim().toLowerCase(), lms_name:String(x.name||'').slice(0,200), sources:x.srcText.slice(0,500),
    done:x.done, total:x.total, rate:Math.round(x.rate*10)/10, state:x.state, final_done:x.fDone,
    final_status:(x.fStatus==='(not in file)' ? '' : x.fStatus).slice(0,200),
    final_at: x.fDone ? iso(x.fAt) : null, final_at_raw:x.fRaw.slice(0,200),
    latest_at:iso(x.latest), latest_raw:String(x.latestRaw||'').slice(0,200), missing:x.missing.slice(0,500)
  }));
  const unread = rpUnreadableOf(pub);
  const inc = s.model.acts.filter(a=>s.include[a.key]);
  const finalsUniq = [...new Set(s.files.map(f=>rpFinalOf(f).name))];
  return {
    courseId:c.id, rows,
    files:s.files.map(f=>({fileName:f.fileName, label:f.label, rows:f.rows.length, videos:f.acts.length})),
    stats:{rowsIn:s.model.rowCount, students:s.res.length, stored:rows.length, excluded:s.res.length-base.length,
      noEmail:base.length-pub.length, unreadableTimestamps:unread.count},
    settings:{finalVideos:s.files.map(f=>({sheet:f.label||f.fileName, video:rpFinalOf(f).name})), includedVideos:inc.map(a=>a.name),
      acceptedStatuses:Object.keys(s.done).filter(k=>s.done[k]), rejectedStatuses:Object.keys(s.done).filter(k=>!s.done[k]),
      includedSummary:inc.length+' of '+s.model.acts.length,
      mergeRule: s.files.length>1 ? 'Students matched by email; a video is completed if completed in any sheet (earliest timestamp); each sheet has its own final video.' : ''},
    engine:{finalVideos:finalsUniq, acceptedStatuses:Object.keys(s.done).filter(k=>s.done[k]),
      excludedVideos:s.model.acts.filter(a=>!s.include[a.key]).map(a=>a.name)},
    deadline: s.deadline!==null ? new Date(s.deadline).toISOString() : null,
    _unread: unread, _notInRoster: pub.filter(x=>x.match==='not_in_roster').length, _onboarding: pub.filter(x=>x.match==='onboarding').length
  };
}
function rpPublish(){
  const c = rpCurrentCourse();
  if(!c){ toast('Choose the course in step 0 first','err'); document.getElementById('rpCourse').focus(); return; }
  if(c.source!=='moodle'){ toast('Only Moodle courses can be published here','err'); return; }
  if(!rpState.model || !rpState.res.length){ toast('Upload a completion sheet first','err'); return; }
  const p = rpPublishPayload(c);
  if(!p.rows.length){ toast('Nothing to publish — every student is excluded or has no valid email','err'); return; }
  rpState._pending = p;
  const u = p._unread;
  showModal(`<h3>Publish to "${esc(rpCourseTitle(c))}"</h3>
    <ul class="rp-summary">
      <li><b>${p.rows.length}</b> row(s) will be stored</li>
      <li>${p.stats.excluded} excluded (not published)</li>
      <li>${p.stats.noEmail} without a valid email (dropped)</li>
      <li>${p._notInRoster} not in the roster · ${p._onboarding} onboarding learner(s)</li>
      <li>Deadline: ${p.deadline ? esc(rpFmtIso(p.deadline, true))+' KSA' : 'none'}</li>
    </ul>
    ${u.count ? `<div class="rp-note warn">⚠️ <b>${u.count} timestamp(s) couldn't be read</b> (e.g. ${u.examples.map(v=>'<code>'+esc(v)+'</code>').join(', ')}). These completions will be stored as <b>"Completed (date unknown)"</b> — never On time or Late.
      <label style="display:flex;gap:8px;margin-top:8px;align-items:center;"><input type="checkbox" id="rpUnreadOk" onchange="document.getElementById('rpPubGo').disabled=!this.checked"> I understand — publish anyway</label></div>` : ''}
    <p class="rp-note warn"><b>This replaces all current data for ${esc(rpCourseTitle(c))}.</b></p>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok btn-sm" id="rpPubGo" ${u.count?'disabled':''} onclick="rpConfirmPublish()">Publish</button>
    </div>`, 'max-width:620px;');
}
async function rpConfirmPublish(){
  const p = rpState._pending;
  if(!p) return;
  if(p._unread.count && !(document.getElementById('rpUnreadOk')||{}).checked) return;
  const btn = document.getElementById('rpPubGo');
  if(btn){ btn.disabled = true; btn.textContent = 'Publishing…'; }
  const body = {...p}; delete body._unread; delete body._notInRoster; delete body._onboarding;
  try{
    const out = await API.call('coursePublish', body);
    closeModal();
    rpState._pending = null;
    toast(`Published ${out.stored} row(s) to ${rpCourseTitle(rpCurrentCourse())}`,'ok');
    await rpLoadCourses(true);
    await rpRefreshHubColumns();
  }catch(e){
    if(btn){ btn.disabled = false; btn.textContent = 'Publish'; }
    toast('Publish failed — '+(e.message||'please try again'),'err');
  }
}

/* ---------- 8. onboarding learners ---------- */
async function rpLoadLearners(quiet){
  try{
    const out = await API.call('lmsLearnersList', null, !!quiet);
    rpState.learners = out.learners || [];
    rpState.learnersLoaded = true;
  }catch(e){ if(!quiet) toast('Could not load onboarding learners — '+(e.message||''),'err'); return; }
  rpRenderLearners();
  if(rpState.model) rpRecompute();
}
function rpRenderLearners(){
  const tb = document.getElementById('rpOnbBody');
  if(!tb) return;
  tb.innerHTML = rpState.learners.length ? rpState.learners.map(l=>`<tr>
      <td class="name-cell">${esc(l.displayName||'—')}${l.inRoster?' <span class="rp-tag ok" title="This email is now in the roster — the roster record is used">in roster</span>':''}</td>
      <td class="email-cell">${esc(l.email)}</td><td>${esc(l.district||'—')}</td><td>${esc(l.areaManager||'—')}</td><td>${esc(l.city||'—')}</td>
      <td>${esc(l.supervisor||'—')}</td><td>${esc(l.pharmacyNo||'—')}</td><td>${esc(l.employeeId||'—')}</td>
      <td style="white-space:nowrap">${esc(rpFmtIso(l.createdAt))}${l.createdBy?' · '+esc(l.createdBy):''}</td>
      <td><button class="btn btn-danger btn-sm" onclick="rpDeleteLearner('${esc(l.email)}')">Delete</button></td>
    </tr>`).join('') : `<tr><td colspan="10" class="empty-msg">No onboarding learners</td></tr>`;
}
function rpLearnerMsg(out){
  const el = document.getElementById('rpOnbMsg');
  let msg = `Saved ${out.saved} learner(s).`;
  if(out.alreadyInRoster && out.alreadyInRoster.length) msg += ` Already in the roster (not added): ${out.alreadyInRoster.slice(0,10).join(', ')}${out.alreadyInRoster.length>10?' …':''}.`;
  if(out.invalid && out.invalid.length) msg += ` ${out.invalid.length} row(s) had no valid email.`;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('warn', !!((out.alreadyInRoster||[]).length || (out.invalid||[]).length));
}
async function rpSaveLearners(rows){
  try{
    const out = await API.call('lmsLearnersUpsert', {rows});
    rpLearnerMsg(out);
    await rpLoadLearners();
    return true;
  }catch(e){ toast('Could not save — '+(e.message||'please try again'),'err'); return false; }
}
const RP_LEARNER_FIELDS = [['email','Email (Username)',true],['displayName','Display name',true],['district','District'],['areaManager','Area Manager'],
  ['city','City'],['supervisor','Supervisor Name'],['pharmacyNo','Pharmacy No.'],['employeeId','User / Employee ID']];
function rpOpenAddLearner(){
  showModal(`<h3>Add an onboarding learner</h3>
    <p class="small-note">For completion reports only — they never join the roster. An email already in the roster is refused.</p>
    <div class="de-grid">${RP_LEARNER_FIELDS.map(f=>`<label><span class="field-label${f[2]?' req':''}">${esc(f[1])}</span><input id="rpL_${f[0]}" ${f[0]==='email'?'type="email"':''}></label>`).join('')}</div>
    <div class="modal-actions"><button class="btn btn-outline btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-navy btn-sm" onclick="rpSaveOneLearner()">Save</button></div>`, 'max-width:640px;');
}
async function rpSaveOneLearner(){
  const row = {};
  RP_LEARNER_FIELDS.forEach(f=>{ row[f[0]] = document.getElementById('rpL_'+f[0]).value.trim(); });
  if(!RP_EMAIL_RE.test(row.email)){ toast('Enter a valid email','err'); return; }
  if(!row.displayName){ toast('Enter the display name','err'); return; }
  if(await rpSaveLearners([row])) closeModal();
}
async function rpOnLearnersFile(input){
  const f = input.files[0];
  input.value = '';
  if(!f) return;
  try{
    const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), {type:'array', raw:true});
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:false, defval:'', blankrows:false});
    if(!aoa.length) throw new Error('the file is empty');
    const h = aoa[0].map(x=>String(x||'').trim());
    const col = res=>{ for(const re of res){ const i = h.findIndex(x=>re.test(x)); if(i>-1) return i; } return -1; };
    const idx = { email:col([/e-?mail/i, /^username/i]), displayName:col([/display.*name/i, /pharmacist.*name/i, /^name$/i]),
      district:col([/district/i]), areaManager:col([/area\s*manager/i]), city:col([/^city$/i, /\bcity\b/i]), supervisor:col([/supervisor/i]),
      pharmacyNo:col([/pharmacy\s*no/i, /pharmacy/i]), employeeId:col([/employee\s*id/i, /user.*id/i, /employee/i]) };
    if(idx.email<0) throw new Error('no "Username (Email)" column found');
    const rows = aoa.slice(1).map(r=>{ const o = {}; Object.keys(idx).forEach(k=>{ o[k] = idx[k]>-1 ? String(r[idx[k]]||'').trim() : ''; }); return o; })
      .filter(o=>o.email);
    if(!rows.length) throw new Error('no rows with an email');
    if(rows.length>5000) throw new Error('more than 5000 rows — split the file');
    await rpSaveLearners(rows);
  }catch(e){ toast(`Could not read "${f.name}": ${e.message||'unknown error'}`,'err'); }
}
async function rpDeleteLearner(email){
  if(!await confirmDialog(`Remove onboarding learner ${email}? Their published completion rows stay, but will show as "Not in roster".`)) return;
  try{ await API.call('lmsLearnersDelete', {emails:[email]}); toast('Removed','ok'); await rpLoadLearners(); }
  catch(e){ toast('Could not remove — '+(e.message||''),'err'); }
}

/* ═══════════════════════════════ SAP REPORTS TAB ═══════════════════════════════ */
async function rpOpenSapTab(){ await rpLoadCourses(); rpRenderSapList(); }
function rpRenderSapList(){
  const el = document.getElementById('rpSapList');
  if(!el) return;
  const sap = rpState.courses.filter(c=>c.source==='sap');
  el.innerHTML = sap.length
    ? `<p class="small-note" style="margin-top:12px">SAP courses already tracked:</p><ul class="rp-sap-list">${sap.map(c=>`<li>${esc(rpCourseTitle(c))}${c.category?' <span class="small-note">· '+esc(c.category)+'</span>':''}</li>`).join('')}</ul>`
    : `<p class="small-note" style="margin-top:12px">No SAP course is tracked yet — you can add one in Reports Configuration.</p>`;
}

/* ═══════════════════════════════ REPORTS CONFIGURATION TAB ═══════════════════════════════ */
async function rpOpenConfigTab(){
  await rpLoadCourses(true);
  rpRenderCfgForm();
}
function rpEditCourse(id){ rpState.editingId = id; rpRenderCfgForm(); const card = document.getElementById('rpCfgFormCard'); if(card && id) card.scrollIntoView({behavior:'smooth', block:'start'}); }
function rpRenderCfgForm(){
  const card = document.getElementById('rpCfgFormCard');
  if(!card) return;
  const c = rpState.editingId ? rpCourse(rpState.editingId) : null;
  const d = c ? c.display : {columns:RP_DISPLAY_COLUMNS.map(x=>x[0]), showDeadline:true, showDaysLeft:true, includeRosterNoData:false};
  const cats = [...new Set(rpState.courses.map(x=>x.category).filter(Boolean))].sort();
  card.innerHTML = `${c ? `<p class="small-note" style="margin-top:0">Editing <b>${esc(rpCourseTitle(c))}</b></p>` : ''}
    <div class="de-grid">
      <label><span class="field-label req">Course name</span><input id="rpCfgName" maxlength="150" value="${esc(c?c.name:'')}"></label>
      <label><span class="field-label req">Source</span><select id="rpCfgSource" ${c && c.rowCount>0 ? 'disabled title="The source can\'t change after data was published"' : ''}>
        <option value="moodle" ${!c || c.source==='moodle'?'selected':''}>Moodle</option><option value="sap" ${c && c.source==='sap'?'selected':''}>SAP</option></select></label>
      <label><span class="field-label">Display name (optional)</span><input id="rpCfgDisplay" maxlength="150" value="${esc(c?c.displayName:'')}"></label>
      <label><span class="field-label">Category</span><input id="rpCfgCategory" maxlength="80" list="rpCfgCats" value="${esc(c?c.category:'')}"><datalist id="rpCfgCats">${cats.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></label>
      <label><span class="field-label">Display order</span><input id="rpCfgOrder" type="number" step="1" value="${c?c.sortOrder:0}"></label>
      <label class="rp-check"><input type="checkbox" id="rpCfgActive" ${c && c.active?'checked':''}> <span><b>Active</b> — visible on the public page</span></label>
    </div>
    ${c ? `<div class="rp-subcard">
      <h3>What the public page shows</h3>
      <div class="rp-cols">${RP_DISPLAY_COLUMNS.map(([k,l])=>`<label><input type="checkbox" class="rpCfgCol" value="${k}" ${(d.columns||[]).indexOf(k)>-1?'checked':''}> ${esc(l)}</label>`).join('')}</div>
      <div class="rp-cols" style="margin-top:8px">
        <label><input type="checkbox" id="rpCfgShowDl" ${d.showDeadline?'checked':''}> Show deadline</label>
        <label><input type="checkbox" id="rpCfgShowDays" ${d.showDaysLeft?'checked':''}> Show Days Left</label>
        <label><input type="checkbox" id="rpCfgNoData" ${d.includeRosterNoData?'checked':''}> Show roster people with no completion data</label>
      </div>
      <p class="small-note">With "no completion data" on, the whole roster appears and people missing from the upload are labelled "No completion data"; off, only people in the uploaded file appear.</p>
    </div>` : ''}
    <div class="modal-actions" style="justify-content:flex-start">
      <button class="btn btn-navy btn-sm" onclick="rpSaveCourseForm()">${c ? 'Save changes' : '+ Track course'}</button>
      ${c ? `<button class="btn btn-outline btn-sm" onclick="rpEditCourse(null)">Cancel</button>` : ''}
    </div>`;
}
async function rpSaveCourseForm(){
  const c = rpState.editingId ? rpCourse(rpState.editingId) : null;
  const name = document.getElementById('rpCfgName').value.trim();
  if(!name){ toast('Enter the course name','err'); return; }
  const course = { name, source:document.getElementById('rpCfgSource').value, active:document.getElementById('rpCfgActive').checked,
    displayName:document.getElementById('rpCfgDisplay').value.trim(), category:document.getElementById('rpCfgCategory').value.trim(),
    sortOrder:Number(document.getElementById('rpCfgOrder').value)||0 };
  if(c){
    course.id = c.id;
    // keep display options a newer page may have added (the server merges over what is stored)
    course.display = Object.assign({}, c.display, {
      columns:[...document.querySelectorAll('.rpCfgCol:checked')].map(x=>x.value),
      showDeadline:document.getElementById('rpCfgShowDl').checked, showDaysLeft:document.getElementById('rpCfgShowDays').checked,
      includeRosterNoData:document.getElementById('rpCfgNoData').checked });
  }
  try{
    await API.call('courseSave', {course});
    toast(c ? 'Course saved' : 'Course tracked — publish its data from Moodle Reports','ok');
    rpState.editingId = null;
    await rpLoadCourses(true);
    rpRenderCfgForm();
  }catch(e){ toast('Could not save — '+(e.message||'please try again'),'err'); }
}
async function rpToggleActive(id, on){
  const c = rpCourse(id);
  if(!c) return;
  try{
    await API.call('courseSave', {course:{id:c.id, name:c.name, source:c.source, active:on, displayName:c.displayName, category:c.category, sortOrder:c.sortOrder}});
    toast(on ? 'Shown on the public page' : 'Hidden from the public page','ok');
  }catch(e){ toast('Could not change it — '+(e.message||''),'err'); }
  await rpLoadCourses(true);
}
function rpShareUrl(slug){ return new URL('reports.html?c='+encodeURIComponent(slug), location.href).href; }
async function rpCopyShare(id){
  const c = rpCourse(id);
  if(!c) return;
  const url = rpShareUrl(c.shareSlug);
  try{ await navigator.clipboard.writeText(url); toast('Share link copied','ok'); }
  catch(e){ showModal(`<h3>Share link</h3><input style="width:100%" readonly value="${esc(url)}" onfocus="this.select()"><div class="modal-actions"><button class="btn btn-navy btn-sm" onclick="closeModal()">Close</button></div>`); }
}
async function rpRotateShare(id){
  const c = rpCourse(id);
  if(!c || !await confirmDialog(`Create a new share link for "${rpCourseTitle(c)}"? The current link stops working straight away.`)) return;
  try{ await API.call('courseShareRotate', {id}); toast('New share link created','ok'); await rpLoadCourses(true); }
  catch(e){ toast('Could not renew the link — '+(e.message||''),'err'); }
}
async function rpDeleteCourse(id){
  const c = rpCourse(id);
  if(!c || !await confirmDialog(`Delete "${rpCourseTitle(c)}" and all its published data (${c.rowCount} rows) and publish history? This can't be undone.`)) return;
  try{ await API.call('courseDelete', {id}); toast('Course deleted','ok'); if(rpState.courseId===id) rpState.courseId = ''; await rpLoadCourses(true); }
  catch(e){ toast('Could not delete — '+(e.message||''),'err'); }
}
function rpOpenInMoodle(id){
  switchTrainerTab('t-moodle');
  const sel = document.getElementById('rpCourse');
  if(sel){ sel.value = id; rpOnCourseChange(); }
}
function rpRenderCoursesTable(){
  const tb = document.getElementById('rpCoursesBody');
  if(!tb) return;
  const sa = typeof isSuperAdmin==='function' && isSuperAdmin();
  tb.innerHTML = rpState.courses.length ? rpState.courses.map(c=>`<tr>
      <td class="name-cell"><b>${esc(rpCourseTitle(c))}</b>${c.displayName && c.displayName!==c.name ? '<br><span class="small-note">'+esc(c.name)+'</span>' : ''}
        ${c.active && !c.lastPublishedAt ? ' <span class="rp-tag mid" title="The public page shows it as \'No data published yet\'">No data yet</span>' : ''}</td>
      <td><span class="badge ${c.source==='sap'?'badge-leave':'badge-date'}">${c.source==='sap'?'SAP':'Moodle'}</span></td>
      <td><label class="rp-switch" title="Visible on the public page"><input type="checkbox" ${c.active?'checked':''} onchange="rpToggleActive('${c.id}', this.checked)"> ${c.active?'Active':'Off'}</label></td>
      <td>${esc(c.category||'—')}</td>
      <td>${c.sortOrder}</td>
      <td style="white-space:nowrap">${c.lastPublishedAt ? esc(rpAgo(c.lastPublishedAt))+'<br><span class="small-note">'+esc(c.lastPublishedBy||'')+'</span>' : '<span class="small-note">—</span>'}</td>
      <td>${c.rowCount}</td>
      <td style="white-space:nowrap">${c.deadline ? esc(rpFmtIso(c.deadline, true)) : '—'}</td>
      <td style="white-space:nowrap"><button class="btn btn-outline btn-sm" title="Copy the public link to this course" onclick="rpCopyShare('${c.id}')">📋 Copy</button>
        <button class="btn btn-outline btn-sm" title="Make a new link — the old one stops working" onclick="rpRotateShare('${c.id}')">↻</button></td>
      <td class="no-truncate"><button class="btn btn-outline btn-sm" onclick="rpEditCourse('${c.id}')">Edit</button>
        <button class="btn btn-navy btn-sm" onclick="rpDownloadCourseData('${c.id}')" ${c.lastPublishedAt?'':'disabled title="Nothing published yet"'}>⬇ Download data</button>
        ${c.source==='moodle' ? `<button class="btn btn-outline btn-sm" onclick="rpOpenInMoodle('${c.id}')">Open in Moodle Reports</button>` : ''}
        ${sa ? `<button class="btn btn-danger btn-sm" onclick="rpDeleteCourse('${c.id}')">Delete</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="10" class="empty-msg">No course is tracked yet — add one above</td></tr>`;
}
const RP_EXPORT_MATCH = {roster:'Roster', onboarding:'Onboarding', not_in_roster:'Not in roster', no_data:'No completion data'};
async function rpDownloadCourseData(id){
  let out;
  try{ out = await API.call('courseExport', {id}); }
  catch(e){ toast('Could not load the course data — '+(e.message||''),'err'); return; }
  const c = out.course;
  const headers = ['Name','Email','District','Area Manager','City','Supervisor','Roster match','Videos completed','Total videos','Completion rate %',
    'State','Final video completed at','Latest completion (any video)','Deadline','Schedule','Days late / overdue'];
  const dl = c.deadline ? rpFmtIso(c.deadline, true)+' KSA' : '';
  const rows = out.rows.map(r=>[r.name, r.email, r.district, r.areaManager, r.city, r.supervisor, RP_EXPORT_MATCH[r.match]||r.match,
    r.done===null?'':r.done, r.total===null?'':r.total, r.rate===null?'':r.rate, r.state,
    r.finalDone ? (r.finalAt ? rpFmtIso(r.finalAt, true) : 'Completed (no date)') : '',
    r.latestAt ? rpFmtIso(r.latestAt, true) : (r.latestRaw||''), dl, r.schedule, r.scheduleDays||'']);
  const u = out.lastUpload, st = (u && u.stats) || {}, se = (u && u.settings) || {};
  const info = [['Course', c.name + (c.displayName && c.displayName!==c.name ? ' (shown as "'+c.displayName+'")' : '')],
    ['Last published', u ? rpFmtIso(u.at, true)+' KSA by '+(u.by||'') : '—'],
    ['Source files', u ? (u.files||[]).map(f=>`${f.label} (${f.fileName}, ${f.rows} rows, ${f.videos} videos)`).join(' | ') : ''],
    ['Final videos', (se.finalVideos||[]).map(f=>f.sheet+': '+f.video).join(' | ')],
    ['Videos included in rate', (se.includedSummary||'') + ((se.includedVideos||[]).length ? ' — '+se.includedVideos.join(' | ') : '')],
    ['Statuses counted as completed', (se.acceptedStatuses||[]).join(' | ')],
    ['Statuses NOT counted', (se.rejectedStatuses||[]).join(' | ')],
    ['Deadline', dl || 'none'],
    ['Rows in files / students / stored', [st.rowsIn, st.students, st.stored].map(v=>v===undefined?'—':v).join(' / ')],
    ['Excluded at publish (count only) / no email', [st.excluded, st.noEmail].map(v=>v===undefined?'—':v).join(' / ')],
    ['Matched to roster / onboarding / not in roster', [st.matchedRoster, st.matchedOnboarding, st.notInRoster].map(v=>v===undefined?'—':v).join(' / ')],
    ['Unreadable timestamps at publish', st.unreadableTimestamps===undefined ? '—' : st.unreadableTimestamps],
    ['Roster people with no completion data', out.includeNoData ? 'included' : 'not included'],
    ['Times', 'KSA (UTC+3). A finished learner whose time couldn\'t be read is "Completed (date unknown)" — never On time / Late.']];
  if(se.mergeRule) info.push(['Merge rule', se.mergeRule]);
  const name = reportFileName(rpCourseTitle(c), c.source, 'xlsx');
  const ok = await downloadStyledXlsx(name, 'Completion', headers, rows, null, {autoName:true, sheets:[
    {name:'Completion', headers, rows, opts:{autoFilter:true, statusCols:[headers.indexOf('State'), headers.indexOf('Roster match')]}},
    {name:'Settings used', headers:['Setting','Value'], rows:info, colWidths:[44,100]}
  ]});
  if(ok) toast('Downloaded — '+name,'ok');
}
function rpRenderSlots(){
  const card = document.getElementById('rpSlotsCard');
  if(!card) return;
  const opt = cur=>`<option value="">— none —</option>` + rpState.courses.map(c=>`<option value="${esc(c.id)}" ${c.id===cur?'selected':''}>${esc(rpCourseTitle(c))}${c.source==='sap'?' (SAP)':''}</option>`).join('');
  const last = id=>{ const c = rpCourse(id); return !c ? '' : (c.lastPublishedAt ? 'published '+rpFmtIso(c.lastPublishedAt, true)+' ('+rpAgo(c.lastPublishedAt)+')' : 'not published yet'); };
  card.innerHTML = `<div class="de-grid">
      <label><span class="field-label">Core course</span><select id="rpSlotCore">${opt(rpState.coreCourseId)}</select><span class="small-note">${esc(last(rpState.coreCourseId))}</span></label>
      <label><span class="field-label">Capsule course</span><select id="rpSlotCapsule">${opt(rpState.capsuleCourseId)}</select><span class="small-note">${esc(last(rpState.capsuleCourseId))}</span></label>
    </div>
    <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-navy btn-sm" onclick="rpSaveSlots()">Save</button></div>`;
}
async function rpSaveSlots(){
  try{
    await API.call('courseSlotsSet', {coreCourseId:document.getElementById('rpSlotCore').value||null, capsuleCourseId:document.getElementById('rpSlotCapsule').value||null});
    toast('Core / Capsule courses saved','ok');
    await rpLoadCourses(true);
    await rpRefreshHubColumns();
  }catch(e){ toast('Could not save — '+(e.message||''),'err'); }
}

// After a publish or a new Core / Capsule choice, the Attendance tab's columns follow without a page reload.
async function rpRefreshHubColumns(){
  if(typeof getShared!=='function') return;
  courseSlots = await getShared(K_COURSE_SLOTS, courseSlots);
  if(typeof renderTrainerTable==='function') renderTrainerTable();
  if(typeof renderCompletionSourceCard==='function') renderCompletionSourceCard();
}

/* ═══════════════════════════════ SELF-TEST (open the page with ?debug=1, or run rpSelfTest() in the console) ═══════════════════════════════ */
function rpSelfTest(){
  const out = [];
  const ok = (name, cond, got)=>out.push({test:name, result:cond?'PASS':'FAIL', got:cond?'':JSON.stringify(got)});
  const ksa = (y,mo,d,h,mi,s)=>Date.UTC(y,mo-1,d,h,mi,s||0) - RP_KSA_MS;
  // timestamps (all KSA)
  const t1430 = ksa(2026,10,5,14,30);
  ok('ISO "2026-10-05 14:30"', rpParseTs('2026-10-05 14:30')===t1430, rpParseTs('2026-10-05 14:30'));
  ok('day-first "5/10/2026 2:30 PM" = 5 October', rpParseTs('5/10/2026 2:30 PM')===t1430, rpParseTs('5/10/2026 2:30 PM'));
  ok('"Monday, 5 October 2026, 2:30 PM"', rpParseTs('Monday, 5 October 2026, 2:30 PM')===t1430, rpParseTs('Monday, 5 October 2026, 2:30 PM'));
  ok('Excel serial 46300.6 = 5 Oct 2026 14:24 KSA', rpParseTs(46300.6)===ksa(2026,10,5,14,24), rpFmtKsa(rpParseTs(46300.6), true));
  ok('serial as text "46300.6"', rpParseTs('46300.6')===ksa(2026,10,5,14,24));
  ok('"12:30 AM" is just after midnight', rpParseTs('5/10/2026 12:30 AM')===ksa(2026,10,5,0,30));
  ok('unreadable → null ("yesterday", "31/31/2026", "2026/10/05 14:30")', rpParseTs('yesterday')===null && rpParseTs('31/31/2026')===null && rpParseTs('2026/10/05 14:30')===null);
  // merge + earliest timestamp + date unknown
  const sheet = (rows)=>[['Name','Email','Video 1',''], ...rows];
  const fA = Object.assign(rpParseAoa(sheet([['Test A','Test@x.com','Completed','2026-06-10 10:00'], ['No Date','nd@x.com','Completed',''], ['Bad Date','bd@x.com','Completed','yesterday']])), {id:'A', label:'A'});
  const fB = Object.assign(rpParseAoa(sheet([['Test A','test@x.com','Completed','2026-05-10 10:00']])), {id:'B', label:'B'});
  const model = rpBuildModel([fA, fB]);
  ok('Test@x.com + test@x.com → one student', model.students.filter(s=>s.email.toLowerCase()==='test@x.com').length===1, model.students.length);
  const cfg = extra=>Object.assign({files:[fA,fB], model, done:{'Completed':true,'(blank)':false}, include:{'video 1':true}, finals:{A:'video 1', B:'video 1'},
    deadline:null, cutoff:null, cutoffMode:'before', cutoffBasis:'final', now:ksa(2026,12,1,0,0), label:id=>id}, extra||{});
  let res = rpEvaluate(cfg());
  const by = e=>res.find(x=>x.email.toLowerCase()===e);
  ok('June on A + May on B keeps May', by('test@x.com').fAt===ksa(2026,5,10,10,0), rpFmtKsa(by('test@x.com').fAt, true));
  const dl = ksa(2026,10,5,23,59,59);
  res = rpEvaluate(cfg({deadline:dl}));
  ok('blank timestamp → Completed (date unknown)', by('nd@x.com').fDone && by('nd@x.com').fAt===null && by('nd@x.com').sched==='Completed (date unknown)', by('nd@x.com').sched);
  ok('unreadable timestamp → Completed (date unknown), never On time/Late', by('bd@x.com').sched==='Completed (date unknown)' && by('bd@x.com').unread.length===1, by('bd@x.com'));
  ok('blank timestamp is not counted as unreadable', by('nd@x.com').unread.length===0);
  // deadline 23:59 inclusive
  ok('23:59:30 is On time', rpSchedule(true, ksa(2026,10,5,23,59,30), dl, 0).s==='On time');
  const late = rpSchedule(true, ksa(2026,10,6,0,0,10), dl, 0);
  ok('00:00:10 next day is Late by 1 day', late.s==='Late' && late.days===1, late);
  ok('date unknown never Late', rpSchedule(true, null, dl, 0).s==='Completed (date unknown)');
  // cut-off: before (strictly before midnight) / on or before (whole day), both bases
  const before = ksa(2026,10,5,0,0,0), onBefore = ksa(2026,10,5,23,59,59), onDay = ksa(2026,10,5,9,0);
  ok('cut-off "before 5 Oct": 5 Oct 09:00 → completed later', rpCutoffCheck(true, onDay, before, 'before').s==='No, completed later');
  ok('cut-off "on or before 5 Oct": 5 Oct 09:00 → Yes', rpCutoffCheck(true, onDay, onBefore, 'onbefore').s==='Yes');
  ok('cut-off: not completed', rpCutoffCheck(false, null, before, 'before').s==='No, not completed');
  const allBasis = rpEvaluate(cfg({cutoff:onBefore, cutoffMode:'onbefore', cutoffBasis:'all'}));
  ok('cut-off "every video" basis uses the latest completion', allBasis.find(x=>x.email.toLowerCase()==='test@x.com').cb==='Yes');
  // @domain exclusion: out of the stats, the publish and the Excel
  const ex = rpExclusionSets('@x.com\nsomeone@else.org');
  res.forEach(x=>{ x.excluded = rpIsExcludedBy(ex, x.email); });
  ok('@x.com excludes every @x.com student', res.every(x=>x.excluded));
  ok('excluded rows are not publishable', rpPublishable(res).length===0);
  ok('rpIsExcludedBy is case-insensitive and exact-suffix', rpIsExcludedBy(ex, 'A@X.COM') && !rpIsExcludedBy(ex, 'a@x.com.sa'));
  ok('file name is Windows-safe', /^\d{1,2} \w{3} \d{2} - \d{1,2} (AM|PM) - Q1 Report Sales - Moodle\.xlsx$/.test(reportFileName('Q1: Report / Sales?*', 'moodle')), reportFileName('Q1: Report / Sales?*', 'moodle'));
  const failed = out.filter(r=>r.result==='FAIL').length;
  console.table(out);
  console.log(failed ? `rpSelfTest: ${failed} FAILED` : `rpSelfTest: all ${out.length} passed`);
  return out;
}
if(/[?&]debug=1\b/.test(location.search)) document.addEventListener('DOMContentLoaded', ()=>setTimeout(rpSelfTest, 0));
