/* ════════════════════════════════════════════════════════════════════
   Public course progress page (reports.html) — no login.
   Reads only two read-only actions of the "api" Edge Function:
     reportsPublic                → active courses with their totals (no names, no emails)
     reportsPublicCourse {slug}   → one active course's rows — only the columns switched on in Reports Configuration
                                    (the server leaves the others out of the response; switch Email off to hide emails)
   A link with ?c=<share link id> opens that one course in a locked view. When the network is down, the last
   answers kept in this browser are shown instead. All globals start with "pub".
   ════════════════════════════════════════════════════════════════════ */
const PUB_CACHE_KEY = 'upc:reports-cache';
const PUB_STATES = ['Completed','Final video done, others missing','In progress','Not started','No completion data'];
const PUB_MATCH = {roster:'In roster', onboarding:'Onboarding', not_in_roster:'Not in roster'};
const PUB_COLS = {   // display.columns key → table column
  num:{label:'#'}, district:{label:'District', f:'di'}, areaManager:{label:'Area Manager', f:'am'}, city:{label:'City', f:'ci'},
  supervisor:{label:'Supervisor', f:'su'}, name:{label:'Name', f:'n'}, email:{label:'Email', f:'e'}, rate:{label:'Completion rate', f:'r'},
  state:{label:'State', f:'s'}, completionDate:{label:'Completion date', f:'f'}, daysLeft:{label:'Days Left'}
};
const PUB_COL_ORDER = ['num','district','areaManager','city','supervisor','name','email','rate','state','completionDate','daysLeft'];
const PUB_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const pubState = { overview:null, course:null, slug:'', locked:false, offline:false, offlineAt:null, q:'', sortKey:'', sortDir:-1, rows:[], syncedAt:null };
let pubFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), state:new Set(), match:new Set(), date:new Set() };
let pubSearchTimer = null;

/* ---------- small helpers ---------- */
function pubAgo(iso){
  if(!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso))/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.round(s/60)+' min ago';
  if(s<86400) return Math.round(s/3600)+'h ago';
  return Math.round(s/86400)+'d ago';
}
// KSA calendar date parts of an ISO time (the reports are about Saudi working days)
function pubKsa(iso){ const d = new Date(Date.parse(iso) + 3*3600*1000); return isNaN(d) ? null : d; }
function pubDateText(iso){   // "05-Oct-26"
  const d = pubKsa(iso);
  return d ? `${String(d.getUTCDate()).padStart(2,'0')}-${PUB_MON[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(-2)}` : '';
}
function pubDateTimeText(iso, seconds){   // "08 Oct 2026 4:25 PM" (KSA)
  const d = pubKsa(iso);
  if(!d) return '';
  let h = d.getUTCHours(); const ap = h>=12 ? 'PM' : 'AM'; h = h%12 || 12;
  const sec = seconds ? ':'+String(d.getUTCSeconds()).padStart(2,'0') : '';
  return `${String(d.getUTCDate()).padStart(2,'0')} ${PUB_MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2,'0')}${sec} ${ap}`;
}
function pubClock(iso){ const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit', second:'2-digit'}); }
function pubIsFinished(x){ return !!x.fd || x.s==='Completed' || x.s==='Final video done, others missing'; }
// Finished / In progress / Not started / No data — the same buckets as the server's totals
function pubBucket(x){
  if(x.s==='No completion data') return 'nodata';
  if(pubIsFinished(x)) return 'finished';
  if(typeof x.r==='number') return x.r>0 ? 'progress' : 'notstarted';
  return x.s==='Not started' ? 'notstarted' : 'progress';
}
// Days Left to the course deadline (KSA calendar days). Finished = Done.
function pubDaysLeft(x, deadline){
  if(!deadline) return {text:'—', cls:'', sort:1e9};
  if(pubIsFinished(x)) return {text:'Done', cls:'done', sort:1e8};
  const now = Date.now(), dl = Date.parse(deadline);
  if(now > dl) return {text:'Overdue', cls:'overdue', sort:-1};
  const today = pubKsa(new Date(now).toISOString()), end = pubKsa(deadline);
  const days = Math.round((Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))/864e5);
  if(days<=0) return {text:'Today!', cls:'critical', sort:0};
  return {text:days+' day'+(days===1?'':'s'), cls: days<=3 ? 'critical' : (days<=7 ? 'warning' : 'ok'), sort:days};
}

/* ---------- loading (live, with the saved copy as a fallback when offline) ---------- */
function pubCacheRead(){ try{ return JSON.parse(localStorage.getItem(PUB_CACHE_KEY)) || {courses:{}}; }catch(e){ return {courses:{}}; } }
function pubCacheWrite(update){
  try{
    const c = pubCacheRead();
    if(update.overview) c.overview = update.overview;
    if(update.course){
      c.courses = c.courses || {};
      c.courses[update.slug] = update.course;
      const keys = Object.keys(c.courses);
      if(keys.length>8) keys.slice(0, keys.length-8).forEach(k=>delete c.courses[k]);   // keep the last few only
    }
    localStorage.setItem(PUB_CACHE_KEY, JSON.stringify(c));
  }catch(e){ /* storage full or blocked — the page still works live */ }
}
const pubIsNetworkError = e=> !!(e && (e.transient || /network|failed to fetch|connection/i.test(e.message||'')));
async function pubFetch(action, extra, cacheGet){
  try{
    const out = await API.call(action, extra);
    pubState.offline = false;
    pubState.syncedAt = new Date().toISOString();
    return out;
  }catch(e){
    if(pubIsNetworkError(e)){
      const cached = cacheGet(pubCacheRead());
      if(cached){ pubState.offline = true; pubState.offlineAt = cached.generatedAt; return cached; }
    }
    throw e;
  }
}
function pubShowError(msg){
  const el = document.getElementById('pubError');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}
// Status bar: "● Live — Course Progress Reports   3 course(s) · Last synced … · Data updated … (course)"
function pubRenderStatus(){
  const live = document.getElementById('pubLive');
  live.classList.toggle('offline', pubState.offline);
  document.getElementById('pubStatusTitle').textContent = pubState.offline ? 'Offline — showing the saved copy' : 'Live — Course Progress Reports';
  const courses = pubState.slug && pubState.course ? [pubState.course] : ((pubState.overview && pubState.overview.courses) || []);
  const latest = courses.filter(c=>c.lastPublishedAt).sort((a,b)=>Date.parse(b.lastPublishedAt)-Date.parse(a.lastPublishedAt))[0];
  const parts = [];
  if(!pubState.slug) parts.push(`${courses.length} course(s)`);
  parts.push(pubState.offline ? `Saved at: ${pubClock(pubState.offlineAt)}` : `Last synced: ${pubClock(pubState.syncedAt)}`);
  if(latest) parts.push(`Data updated: ${pubDateTimeText(latest.lastPublishedAt, true)}${pubState.slug ? '' : ' ('+latest.title+')'}`);
  document.getElementById('pubStatusMeta').textContent = parts.join(' · ');
}
async function pubRefresh(){
  if(pubState.slug) await pubOpenCourse(pubState.slug);
  else await pubLoadOverview();
}

/* ---------- start ---------- */
document.addEventListener('DOMContentLoaded', async ()=>{
  API.init('public');
  registerFilterScope('pub', ()=>pubFilterState, pubRenderTable);
  registerFilterFacets('pub', { items: ()=>pubState.rows, values: {
    district:x=>[x.di||''], areaManager:x=>[x.am||''], city:x=>[x.ci||''], supervisor:x=>[x.su||''],
    state:x=>[x.s], match:x=>[x.fl], date:x=>[x.f ? pubDateText(x.f) : '']
  }});
  getShared('company-logo', null).then(logo=>{ if(logo) document.getElementById('logoBox').innerHTML = '<img alt="" src="'+String(logo).replace(/"/g,'')+'">'; }).catch(()=>{});
  const slug = new URLSearchParams(location.search).get('c');
  if(slug){
    pubState.locked = true;
    document.getElementById('pubViewBar').classList.add('hidden');
    await pubOpenCourse(slug);
  } else {
    await pubLoadOverview();
  }
});

async function pubLoadOverview(){
  let out;
  try{ out = await pubFetch('reportsPublic', null, c=>c.overview); }
  catch(e){ pubShowError('Could not load the reports — '+(e.message||'please try again later')); return; }
  if(!pubState.offline) pubCacheWrite({overview: out});
  pubShowError('');
  pubState.overview = out;
  pubRenderSelect();
  pubShowOverview();
}
function pubSorted(courses){
  return courses.slice().sort((a,b)=>(a.order-b.order) || String(a.title).localeCompare(String(b.title)));
}
function pubRenderSelect(){
  const sel = document.getElementById('pubSelect');
  const courses = pubSorted((pubState.overview && pubState.overview.courses) || []);
  const cats = [...new Set(courses.map(c=>c.category||''))];
  // the count sits in the badge next to the picker, so an option is just the course name
  const opt = c=>`<option value="${esc(c.slug)}">${esc(c.title)}${c.lastPublishedAt ? '' : ' (no data yet)'}</option>`;
  let html = `<option value="">Overview</option>`;
  if(cats.length>=2){
    cats.sort((a,b)=>(a?0:1)-(b?0:1) || a.localeCompare(b)).forEach(cat=>{
      html += `<optgroup label="${esc(cat || 'Other')}">${courses.filter(c=>(c.category||'')===cat).map(opt).join('')}</optgroup>`;
    });
  } else html += courses.map(opt).join('');
  sel.innerHTML = html;
  sel.value = pubState.slug || '';
}
function pubOnSelect(slug){ if(slug) pubOpenCourse(slug); else pubShowOverview(); }
function pubSetViewCount(n, isCourse){
  document.getElementById('pubViewCount').textContent = n;
  document.getElementById('pubViewIcon').textContent = isCourse ? '📘' : '📊';
}

/* ---------- the four numbers (cards and the course summary) ---------- */
// Not started includes roster people with no completion data (they haven't started as far as the LMS knows).
function pubStatBoxesHtml(a){
  const done = a.completed + a.finalOnly, notStarted = a.notStarted + a.noData;
  return `<div class="pub-stats4">
    <div class="pub-st done"><b>${done}</b><span>Done</span></div>
    <div class="pub-st prog"><b>${a.inProgress}</b><span>In progress</span></div>
    <div class="pub-st not"><b>${notStarted}</b><span>Not started</span></div>
    <div class="pub-st total"><b>${a.total}</b><span>Total</span></div>
  </div>`;
}
function pubProgressHtml(rate){
  const r = Math.max(0, Math.min(100, Math.round(Number(rate)||0)));
  return `<div class="pub-progress"><div class="pub-progress-track"><i style="width:${r}%"></i></div>
    <div class="pub-progress-lbl"><span>Completion</span><span>${r}%</span></div></div>`;
}
function pubNotesHtml(a){
  const notes = [];
  if(a.noData) notes.push(`${a.noData} in the roster with no completion data (counted as not started)`);
  if(a.notInRoster) notes.push(`${a.notInRoster} not in the roster`);
  return notes.length ? `<div class="small-note pub-card-note">${esc(notes.join(' · '))}</div>` : '';
}
function pubModulesBadge(a){ return a && a.modules ? `<span class="pub-modules">${a.modules} module${a.modules===1?'':'s'}</span>` : ''; }
function pubAggOfRows(rows, base){
  const a = {total:rows.length, completed:0, finalOnly:0, inProgress:0, notStarted:0, noData:0, notInRoster:0, avgRate:0, modules:(base && base.modules)||0};
  let sum = 0, n = 0;
  rows.forEach(x=>{
    if(x.fl==='not_in_roster') a.notInRoster++;
    const b = pubBucket(x);
    if(b==='nodata') a.noData++;
    else if(b==='finished'){ if(x.s==='Completed') a.completed++; else a.finalOnly++; }
    else if(b==='progress') a.inProgress++;
    else a.notStarted++;
    if(b!=='nodata' && typeof x.r==='number'){ sum += x.r; n++; }
  });
  a.avgRate = n ? sum/n : ((base && base.avgRate) || 0);
  return a;
}

/* ---------- overview ---------- */
function pubShowOverview(){
  pubState.slug = '';
  document.getElementById('pubSelect').value = '';
  document.getElementById('pubCourse').classList.add('hidden');
  document.getElementById('pubToolbar').classList.add('hidden');
  const grid = document.getElementById('pubOverview');
  grid.classList.remove('hidden');
  const courses = pubSorted((pubState.overview && pubState.overview.courses) || []);
  pubSetViewCount(courses.reduce((s,c)=>s+(c.agg.total||0), 0), false);
  pubRenderStatus();
  grid.innerHTML = courses.length ? courses.map(c=>{
    const a = c.agg;
    const dl = c.display && c.display.showDeadline && c.deadline ? `<div class="small-note">Deadline: ${esc(pubDateTimeText(c.deadline))} KSA</div>` : '';
    return `<div class="card pub-card">
      <div class="pub-card-head">
        <div>${c.category ? `<span class="pub-cat">${esc(c.category)}</span>` : ''}<h3>${esc(c.title)}</h3></div>
        ${pubModulesBadge(a)}
      </div>
      ${c.lastPublishedAt ? pubStatBoxesHtml(a) + pubProgressHtml(a.avgRate) + dl + pubNotesHtml(a) : `<div class="pub-nodata">No data published yet</div>`}
      <button type="button" class="btn btn-outline pub-details" onclick="pubOpenCourse('${esc(c.slug)}')" ${c.lastPublishedAt?'':'disabled'}>View Details →</button>
      <div class="pub-updated">${c.lastPublishedAt ? `<i class="dot"></i>Updated ${esc(pubAgo(c.lastPublishedAt))}` : ''}</div>
    </div>`;
  }).join('') : `<div class="card empty-msg">No course reports are published yet.</div>`;
}

/* ---------- one course ---------- */
async function pubOpenCourse(slug){
  let out;
  try{ out = await pubFetch('reportsPublicCourse', {slug}, c=>(c.courses||{})[slug]); }
  catch(e){
    pubShowError(/unavailable/i.test(e.message||'') ? 'Report unavailable — this link is no longer active.' : 'Could not load the report — '+(e.message||'please try again later'));
    if(pubState.locked){
      document.getElementById('pubOverview').classList.add('hidden');
      document.getElementById('pubCourse').classList.add('hidden');
      document.getElementById('pubToolbar').classList.add('hidden');
    }
    return;
  }
  if(!pubState.offline) pubCacheWrite({slug, course: out});
  pubShowError('');
  const keepFilters = pubState.slug===slug;   // Refresh keeps the filters; another course starts clean
  pubState.slug = slug;
  pubState.course = out.course;
  pubState.rows = out.rows || [];
  if(!keepFilters){
    pubFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), state:new Set(), match:new Set(), date:new Set() };
    pubState.q = '';
    const cols = pubVisibleCols();
    pubState.sortKey = cols.includes('rate') ? 'rate' : (cols.includes('name') ? 'name' : '');
    pubState.sortDir = pubState.sortKey==='rate' ? -1 : 1;
  }
  const sel = document.getElementById('pubSelect');
  if(sel && !pubState.locked) sel.value = slug;
  document.getElementById('pubOverview').classList.add('hidden');
  document.getElementById('pubCourse').classList.remove('hidden');
  const c = out.course;
  const a = pubAggOfRows(pubState.rows, c.agg);
  pubSetViewCount(a.total, true);
  pubRenderStatus();
  const lock = document.getElementById('pubLocked');
  lock.classList.toggle('hidden', !pubState.locked);
  if(pubState.locked) lock.innerHTML = `🔒 Shared report · ${esc(c.title)} · ${c.lastPublishedAt ? 'updated '+esc(pubAgo(c.lastPublishedAt)) : 'no data published yet'}`;
  document.getElementById('pubPrintTitle').textContent = c.title + (c.lastPublishedAt ? ' — updated '+pubDateTimeText(c.lastPublishedAt)+' KSA' : '');
  const meta = [];
  if(c.category) meta.push(esc(c.category));
  if(c.display.showDeadline && c.deadline) meta.push('Deadline: '+esc(pubDateTimeText(c.deadline))+' KSA');
  const hasData = !!c.lastPublishedAt;
  document.getElementById('pubSummary').innerHTML = `
    <div class="pub-card-head"><div><h2>${esc(c.title)}</h2>${meta.length ? `<div class="small-note">${meta.join(' · ')}</div>` : ''}</div>${pubModulesBadge(c.agg)}</div>
    ${hasData ? pubStatBoxesHtml(a) + pubProgressHtml(a.avgRate) + pubNotesHtml(a) : ''}
    <div class="pub-updated">${hasData ? `<i class="dot"></i>Updated ${esc(pubAgo(c.lastPublishedAt))}` : ''}</div>`;
  const empty = document.getElementById('pubEmpty');
  empty.classList.toggle('hidden', hasData);
  empty.textContent = hasData ? '' : 'No data published yet.';
  document.getElementById('pubTableCard').classList.toggle('hidden', !hasData);
  document.getElementById('pubToolbar').classList.toggle('hidden', !hasData);
  if(!hasData) return;
  pubBuildFilterBar();
  pubRenderTable();
}
function pubVisibleCols(){
  const c = pubState.course;
  if(!c) return [];
  const on = new Set((c.display && c.display.columns) || []);
  return PUB_COL_ORDER.filter(k=>on.has(k) && (k!=='daysLeft' || (c.display.showDaysLeft && c.deadline)));
}
function pubBuildFilterBar(){
  const rows = pubState.rows, cols = new Set(pubVisibleCols());
  const values = f=>[...new Set(rows.map(x=>x[f]).filter(v=>v))].sort((a,b)=>String(a).localeCompare(String(b))).map(v=>({value:v, text:v}));
  let html = '';
  if(cols.has('name') || cols.has('email')){
    const ph = cols.has('name') && cols.has('email') ? 'Search name or email…' : (cols.has('name') ? 'Search name…' : 'Search email…');
    html += `<div class="filter-field search-field"><div class="search-box"><span>🔍</span><input type="text" class="big-search-input" value="${esc(pubState.q)}" oninput="pubOnSearch(this.value)" placeholder="${ph}"></div></div>`;
  }
  if(cols.has('district')) html += renderMsFilter('pub','district','District', values('di'));
  if(cols.has('areaManager')) html += renderMsFilter('pub','areaManager','Area Manager', values('am'));
  if(cols.has('city')) html += renderMsFilter('pub','city','City', values('ci'));
  if(cols.has('supervisor')) html += renderMsFilter('pub','supervisor','Supervisor', values('su'));
  if(cols.has('completionDate')){
    const dates = [...new Set(rows.filter(x=>x.f).map(x=>x.f.slice(0,10)+'|'+pubDateText(x.f)))].sort().map(v=>({value:v.split('|')[1], text:v.split('|')[1]}));
    html += renderMsFilter('pub','date','Date', [...new Map(dates.map(o=>[o.value,o])).values()]);
  }
  html += renderMsFilter('pub','state','Status', PUB_STATES.filter(s=>rows.some(x=>x.s===s)).map(s=>({value:s, text:s})));
  html += renderMsFilter('pub','match','Roster match', Object.keys(PUB_MATCH).filter(k=>rows.some(x=>x.fl===k)).map(k=>({value:k, text:PUB_MATCH[k]})));
  html += `<button type="button" class="pub-clear" onclick="pubClearFilters()">✕ Clear all</button>`;
  document.getElementById('pubFilterBar').innerHTML = html;
}
function pubOnSearch(v){ clearTimeout(pubSearchTimer); pubSearchTimer = setTimeout(()=>{ pubState.q = v; pubRenderTable(); }, 200); }
function pubClearFilters(){
  pubFilterState = { district:new Set(), areaManager:new Set(), city:new Set(), supervisor:new Set(), state:new Set(), match:new Set(), date:new Set() };
  pubState.q = '';
  pubBuildFilterBar();
  pubRenderTable();
}
function pubView(){
  const fs = pubFilterState, q = pubState.q.trim().toLowerCase();
  const out = pubState.rows.filter(x=>
    (!q || String(x.n||'').toLowerCase().includes(q) || String(x.e||'').toLowerCase().includes(q))
    && inSet(x.di||'', fs.district) && inSet(x.am||'', fs.areaManager) && inSet(x.ci||'', fs.city) && inSet(x.su||'', fs.supervisor)
    && inSet(x.s, fs.state) && inSet(x.fl, fs.match) && inSet(x.f ? pubDateText(x.f) : '', fs.date));
  const k = pubState.sortKey, d = pubState.sortDir, dl = pubState.course.deadline;
  if(!k) return out;
  const val = x=>{
    if(k==='rate') return typeof x.r==='number' ? x.r : -1;
    if(k==='completionDate') return x.f ? Date.parse(x.f) : null;     // chronological; no date at the bottom
    if(k==='daysLeft') return pubDaysLeft(x, dl).sort;
    const f = PUB_COLS[k] && PUB_COLS[k].f;
    return String((f && x[f]) || '').toLowerCase();
  };
  return out.sort((a,b)=>{
    const va = val(a), vb = val(b);
    if(va===null && vb===null) return 0;
    if(va===null) return 1;
    if(vb===null) return -1;
    if(typeof va==='string') return va.localeCompare(vb)*d;
    return (va-vb)*d;
  });
}
function pubSortBy(k){
  if(k==='num') return;
  if(pubState.sortKey===k) pubState.sortDir *= -1;
  else { pubState.sortKey = k; pubState.sortDir = k==='rate' ? -1 : 1; }
  pubRenderTable();
}
function pubFlagBadge(x){
  if(x.fl==='onboarding') return ' <span class="rp-tag mid">Onboarding</span>';
  if(x.fl==='not_in_roster') return ' <span class="rp-tag grey">Not in roster</span>';
  if(x.s==='No completion data') return ' <span class="rp-tag grey">No completion data</span>';
  return '';
}
function pubStateTag(x){
  const b = pubBucket(x);
  const cls = b==='finished' ? 'ok' : (b==='progress' ? 'mid' : (b==='notstarted' ? 'no' : 'grey'));
  return `<span class="rp-tag ${cls}">${esc(x.s)}</span>`;
}
function pubRenderTable(){
  const cols = pubVisibleCols(), rows = pubView(), dl = pubState.course.deadline;
  // the flag badge goes in the first visible of Name / State / Email
  const badgeCol = ['name','state','email'].find(k=>cols.includes(k));
  document.getElementById('pubThead').innerHTML = cols.map(k=>{
    const ar = pubState.sortKey===k ? (pubState.sortDir>0 ? ' ▲' : ' ▼') : '';
    return `<th${k==='num' ? ' class="no-sort"' : ` onclick="pubSortBy('${k}')"`}>${esc(PUB_COLS[k].label)}<span class="sort-ind">${ar}</span></th>`;
  }).join('');
  document.getElementById('pubTbody').innerHTML = rows.length ? rows.map((x,i)=>{
    const days = pubDaysLeft(x, dl);
    const rowCls = cols.includes('daysLeft') ? (days.cls==='overdue' ? 'row-overdue' : (days.cls==='critical' ? 'row-critical' : '')) : '';
    const cell = k=>{
      const badge = k===badgeCol ? pubFlagBadge(x) : '';
      switch(k){
        case 'num': return `<td class="pub-num">${i+1}</td>`;
        case 'city': return `<td>${x.ci ? `<span class="city-badge${String(x.ci).toLowerCase()==='online'?' online':''}">${esc(x.ci)}</span>` : '—'}${badge}</td>`;
        case 'name': return `<td class="name-cell">${esc(x.n||'—')}${badge}</td>`;
        case 'email': return `<td class="email-cell">${esc(x.e||'—')}${badge}</td>`;
        case 'rate': return `<td class="pub-rate">${typeof x.r==='number' ? completionBarHtml(x.r) : '<span class="small-note">—</span>'}</td>`;
        case 'state': return `<td>${pubStateTag(x)}${badge}</td>`;
        case 'completionDate': return `<td style="white-space:nowrap">${x.f ? esc(pubDateText(x.f)) : (pubIsFinished(x) ? '<span class="small-note">(no date)</span>' : '—')}</td>`;
        case 'daysLeft': return `<td><span class="pub-days ${days.cls}">${esc(days.text)}</span></td>`;
        default: { const f = PUB_COLS[k].f; return `<td>${esc((f && x[f]) || '—')}${badge}</td>`; }
      }
    };
    return `<tr class="${rowCls}">${cols.map(cell).join('')}</tr>`;
  }).join('') : `<tr><td colspan="${cols.length||1}" class="empty-msg">No people match the filters</td></tr>`;
  document.getElementById('pubCount').textContent = `${rows.length} of ${pubState.rows.length} shown`;
  const wrap = document.querySelector('#pubTableCard .table-wrap');
  if(wrap){ attachFloatingScrollbar(wrap); updateFloatingScrollbar(wrap); }
}

/* ---------- share link + exports ---------- */
async function pubCopyShare(){
  if(!pubState.slug) return;
  const url = new URL('reports.html?c='+encodeURIComponent(pubState.slug), location.href).href;
  try{ await navigator.clipboard.writeText(url); toast('Link copied — it opens only this course','ok'); }
  catch(e){ showModal(`<h3>Share link</h3><input style="width:100%" readonly value="${esc(url)}" onfocus="this.select()"><div class="modal-actions"><button class="btn btn-navy btn-sm" onclick="closeModal()">Close</button></div>`); }
}
function pubFileName(ext){ const c = pubState.course; return reportFileName(c ? c.title : 'Course report', c ? c.source : 'moodle', ext); }
async function pubExportExcel(){
  const cols = pubVisibleCols(), rows = pubView(), dl = pubState.course && pubState.course.deadline;
  if(!rows.length){ toast('Nothing to export','err'); return; }
  const headers = cols.map(k=>k==='rate' ? 'Completion rate %' : PUB_COLS[k].label).concat(['Roster match']);
  const data = rows.map((x,i)=>cols.map(k=>{
    switch(k){
      case 'num': return i+1;
      case 'rate': return typeof x.r==='number' ? x.r : '';
      case 'completionDate': return x.f ? pubDateText(x.f) : (pubIsFinished(x) ? '(no date)' : '');
      case 'daysLeft': return pubDaysLeft(x, dl).text;
      default: { const f = PUB_COLS[k].f; return (f && x[f]) || ''; }
    }
  }).concat([x.s==='No completion data' ? 'No completion data' : (PUB_MATCH[x.fl]||'')]));
  const name = pubFileName('xlsx');
  const ok = await downloadStyledXlsx(name, 'Completion', headers, data, null,
    {autoName:true, sheets:[{name:'Completion', headers, rows:data, opts:{autoFilter:true, statusCols:[headers.indexOf('State'), headers.length-1].filter(i=>i>-1)}}]});
  if(ok) toast('Excel downloaded','ok');
}
function pubExportImage(){ exportTableImage('pubTableCard', pubFileName('png'), {autoName:true}); }
function pubExportPdf(){ exportTablePDF('pubTableCard', pubFileName('pdf'), {autoName:true}); }
