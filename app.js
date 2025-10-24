/* GolfTrack PWA - app.js (UPDATED: Local course opens in compact current-hole view by default)
   - new round.viewMode: 'current' or 'all'
   - toggle button in active header to switch views
*/

const DB_NAME = 'golftrack-db-v1';
const STORE = 'rounds';

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8) }

// --- IndexedDB helpers ---
function openDB(){
  return new Promise((res,rej)=>{
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(STORE)){
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function saveRound(r){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(r);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function loadAllRounds(){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE,'readonly').objectStore(STORE).getAll();
    tx.onsuccess = ()=> res(tx.result || []);
    tx.onerror = ()=> rej(tx.error);
  });
}
async function deleteRound(id){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = ()=> res();
    tx.onerror = ()=> rej(tx.error);
  });
}

// default config (stored in localStorage)
const DEFAULTS = {
  clubs: ['Driver','3-wood','5-wood','3-iron','4-iron','5-iron','6-iron','7-iron','8-iron','9-iron','PW','GW','SW','LW','Putter'],
  lies: ['Fairway','Rough','Deep Rough','Bunker','Green','Fringe','Woods','Hazard','Other'],
  strokes: ['Full','Pitch','Chip','Bunker','Putt'],
  outcomes: ['Good','Thin','Fat','Topped','Chunk','Hook','Slice','Push','Pull','Shank','Skull','Bladed','Duff','Other'],
  slopes: ['Flat','Uphill','Downhill','Ball Above Feet','Ball Below Feet','Tight Lie','Plugged','Other'],
  favorites: [
    {club:'Putter', outcome:'Good', lie:'Green', stroke:'Putt', label:'Putt Good'},
    {club:'Driver', outcome:'Slice', lie:'Fairway', stroke:'Full', label:'Driver Slice'},
  ]
};

function getConfig(){
  try{
    const raw = localStorage.getItem('golftrack-config');
    if(raw) return JSON.parse(raw);
  }catch(e){}
  localStorage.setItem('golftrack-config', JSON.stringify(DEFAULTS));
  return DEFAULTS;
}
function saveConfig(cfg){ localStorage.setItem('golftrack-config', JSON.stringify(cfg)); }

const CFG = getConfig();

// --- UI helpers & elements ---
const $ = id => document.getElementById(id);
const overlay = $('overlay');
const activeRoundSection = $('activeRound');
const roundTitle = $('roundTitle');
const roundMeta = $('roundMeta');
const recentShots = $('recentShots');
const quickFavorites = $('quickFavorites');

let CURRENT_ROUND = null;

// --- Local course pars (user provided) ---
const LOCAL_COURSE = {
  name: 'Local Course',
  pars: [
    4,3,4,3,5,4,5,4,4,  // holes 1-9
    4,4,5,3,4,5,4,3,4   // holes 10-18
  ]
};

// format date/time
function ymd(d){
  const dt = new Date(d);
  return dt.toISOString().slice(0,10);
}
function timeShort(iso){
  return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

// Helpers for active hole
function getActiveHole(round){
  if(!round) return null;
  if(!Array.isArray(round.holes) || round.holes.length === 0) return null;
  const idx = (typeof round.currentHole === 'number') ? round.currentHole : 0;
  const safeIdx = Math.max(0, Math.min(round.holes.length - 1, idx));
  if(round.currentHole !== safeIdx) round.currentHole = safeIdx;
  return round.holes[safeIdx];
}
function setActiveHoleIndex(round, idx){
  if(!round) return;
  round.currentHole = Math.max(0, Math.min((round.holes||[]).length - 1, idx));
}

// compute strokes for a hole:
function computeHoleStrokes(hole){
  const shots = hole.shots || [];
  const totalShotEntries = shots.length;
  const puttShots = shots.filter(s => (s.strokeType||'').toLowerCase() === 'putt').length;
  const extraPutts = hole.putts || 0;
  const strokes = totalShotEntries + extraPutts - puttShots;
  return Math.max(strokes, totalShotEntries);
}

// compute hole result string relative to par
function holeResult(hole){
  const strokes = computeHoleStrokes(hole);
  const par = hole.par || 0;
  if(par === 0) return `${strokes}`;
  const diff = strokes - par;
  if(diff === 0) return 'E';
  if(diff === -1) return '-1';
  if(diff === 1) return '+1';
  if(diff < -1) return `${diff}`;
  return `+${diff}`;
}

// compute round totals
function computeRoundTotals(round){
  const holes = round.holes || [];
  let totalPar = 0;
  let totalStrokes = 0;
  holes.forEach(h=>{
    totalPar += (h.par || 0);
    totalStrokes += computeHoleStrokes(h);
  });
  const diff = totalStrokes - totalPar;
  return { totalPar, totalStrokes, diff };
}

// --- UI: inject 'Use Local Course' button beside Start Round ---
function injectLocalCourseButton(){
  try{
    const createCard = document.querySelector('.create-round .row.gap') || document.querySelector('.create-round .row');
    if(!createCard) return;
    if(document.getElementById('useLocalCourseBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'useLocalCourseBtn';
    btn.className = 'btn';
    btn.textContent = 'Use Local Course';
    btn.style.minWidth = '140px';
    btn.onclick = ()=> createLocalCourseRound();
    createCard.appendChild(btn);
  }catch(e){}
}

// create round pre-filled with LOCAL_COURSE (compact view by default)
async function createLocalCourseRound(){
  const courseName = LOCAL_COURSE.name;
  const r = { id: uid(), date: new Date().toISOString().slice(0,10), course: courseName, holes: [], notes:'', createdAt:new Date().toISOString(), currentHole:0, viewMode:'current' };
  for(let i=0;i<LOCAL_COURSE.pars.length;i++){
    r.holes.push({ id: uid(), number: i+1, par: LOCAL_COURSE.pars[i], shots: [], putts: 0 });
  }
  await saveRound(r);
  CURRENT_ROUND = r;
  renderActiveRound();
  renderRoundsList();
}

// create / start round (manual)
$('createRound').addEventListener('click', async ()=>{
  const course = $('course').value.trim() || 'Unknown';
  const date = $('roundDate').value || new Date().toISOString().slice(0,10);
  const r = { id: uid(), date, course, holes: [], notes:'', createdAt:new Date().toISOString(), currentHole:0, viewMode:'all' };
  r.holes.push({ id: uid(), number:1, par:4, shots:[], putts:0 });
  await saveRound(r);
  CURRENT_ROUND = r;
  renderActiveRound();
  renderRoundsList();
});

// quick log overlay
$('quickLogBtn').addEventListener('click', ()=> openQuickLog(CURRENT_ROUND));
$('navRounds').addEventListener('click', ()=> { /* keep default main view (rounds) */ });
$('navSettings').addEventListener('click', ()=> openSettings());

// end round
$('endRoundBtn').addEventListener('click', async ()=>{
  if(!CURRENT_ROUND) return;
  if(!confirm('End round and save?')) return;
  CURRENT_ROUND = null;
  renderActiveRound();
  renderRoundsList();
});

// add hole (only up to 18)
$('addHoleBtn').addEventListener('click', async ()=>{
  if(!CURRENT_ROUND) return;
  if((CURRENT_ROUND.holes||[]).length >= 18){
    return alert('Maximum 18 holes reached.');
  }
  const holeNumber = (CURRENT_ROUND.holes.length || 0) + 1;
  CURRENT_ROUND.holes.push({ id: uid(), number: holeNumber, par:4, shots:[], putts:0 });
  setActiveHoleIndex(CURRENT_ROUND, CURRENT_ROUND.holes.length - 1);
  CURRENT_ROUND.viewMode = 'current';
  await saveRound(CURRENT_ROUND);
  renderActiveRound();
});

// export CSV (includes par & strokes & currentHole)
$('exportBtn').addEventListener('click', async ()=>{
  const rounds = await loadAllRounds();
  if(!rounds.length){ alert('No rounds to export'); return; }
  const rows = [['round_id','date','course','hole','par','shot_id','club','stroke','lie','slope','outcome','notes','timestamp','strokes','putts','currentHoleIndex','viewMode']];
  rounds.forEach(r=>{
    r.holes.forEach(h=>{
      const strokes = computeHoleStrokes(h);
      if(h.shots && h.shots.length){
        h.shots.forEach(s=>{
          rows.push([r.id, r.date, r.course, h.number, h.par || '', s.id, s.club, s.strokeType, s.lie || '', s.slope || '', s.outcome, (s.notes||''), s.ts, strokes, h.putts||0, r.currentHole||0, r.viewMode||'all']);
        });
      } else {
        rows.push([r.id, r.date, r.course, h.number, h.par || '', '', '', '', '', '', '', '', '', strokes, h.putts||0, r.currentHole||0, r.viewMode||'all']);
      }
    });
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `golftrack_export_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});

// --- render rounds list (main) ---
async function renderRoundsList(){
  const rounds = (await loadAllRounds()).sort((a,b)=>b.date.localeCompare(a.date));
  const existing = document.querySelector('#roundsListRoot');
  if(existing) existing.remove();

  const listRoot = document.createElement('div');
  listRoot.style.maxWidth = '720px';
  listRoot.style.margin = '0 auto';
  listRoot.id = 'roundsListRoot';

  rounds.forEach(r=>{
    const totals = computeRoundTotals(r);
    const el = document.createElement('div');
    el.className = 'card';
    el.style.marginBottom = '10px';
    el.innerHTML = `<div class="row between">
      <div>
        <div style="font-weight:700">${r.course} <span class="muted small">(${r.date})</span></div>
        <div class="muted small">${(r.holes||[]).length} hole(s) • ${new Date(r.createdAt).toLocaleString()}</div>
        <div class="muted small">Score: ${totals.totalStrokes} (Par ${totals.totalPar}) • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" data-id="${r.id}" data-action="open">Open</button>
        <button class="btn" data-id="${r.id}" data-action="delete">Delete</button>
      </div>
    </div>`;
    listRoot.appendChild(el);
  });

  const createCard = document.querySelector('.create-round');
  createCard.insertAdjacentElement('afterend', listRoot);

  // attach handlers
  listRoot.querySelectorAll('button[data-action="open"]').forEach(b=>{
    b.onclick = async (ev)=> {
      const id = ev.target.getAttribute('data-id');
      const rounds = await loadAllRounds();
      const r = rounds.find(rr=>rr.id===id);
      CURRENT_ROUND = r;
      renderActiveRound();
    };
  });
  listRoot.querySelectorAll('button[data-action="delete"]').forEach(b=>{
    b.onclick = async (ev)=>{
      const id = ev.target.getAttribute('data-id');
      if(!confirm('Delete this round?')) return;
      await deleteRound(id);
      if(CURRENT_ROUND && CURRENT_ROUND.id===id) CURRENT_ROUND=null;
      renderActiveRound();
      renderRoundsList();
    };
  });

  // auto-open latest round if none active
  if(!CURRENT_ROUND && rounds.length) {
    CURRENT_ROUND = rounds[0];
    renderActiveRound();
  }
}

// render active round UI (with per-hole scoring + navigation)
// now respects round.viewMode: 'current' -> shows only active hole; 'all' -> shows full holes grid
function renderActiveRound(){
  if(!CURRENT_ROUND){
    activeRoundSection.classList.add('hidden');
    return;
  }
  activeRoundSection.classList.remove('hidden');
  if(typeof CURRENT_ROUND.currentHole !== 'number') CURRENT_ROUND.currentHole = 0;
  if(!CURRENT_ROUND.viewMode) CURRENT_ROUND.viewMode = 'all';
  const activeHole = getActiveHole(CURRENT_ROUND);
  const lastHoleNumber = activeHole ? activeHole.number : 1;
  const totals = computeRoundTotals(CURRENT_ROUND);
  roundTitle.textContent = `${CURRENT_ROUND.course} • Hole ${lastHoleNumber}`;

  // header meta + view toggle
  const viewToggleText = (CURRENT_ROUND.viewMode === 'current') ? 'Show all holes' : 'Show current hole';
  roundMeta.innerHTML = `Date ${CURRENT_ROUND.date} • ${CURRENT_ROUND.holes.length} hole(s) • Total: ${totals.totalStrokes} (Par ${totals.totalPar}) • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}
    <div style="margin-top:6px"><button id="toggleViewBtn" class="btn" style="padding:8px;font-size:13px">${viewToggleText}</button></div>`;

  // attach toggle handler (delegated after DOM insertion)
  setTimeout(()=> {
    const tbtn = document.getElementById('toggleViewBtn');
    if(tbtn) tbtn.onclick = async ()=>{
      CURRENT_ROUND.viewMode = (CURRENT_ROUND.viewMode === 'current') ? 'all' : 'current';
      await saveRound(CURRENT_ROUND);
      renderActiveRound();
    };
  }, 0);

  // favorites
  quickFavorites.innerHTML = '';
  (CFG.favorites || []).forEach(f=>{
    const b = document.createElement('button');
    b.className = 'favBtn';
    b.textContent = f.label || `${f.club} • ${f.outcome}`;
    b.onclick = ()=> quickLogFromFavorite(f);
    quickFavorites.appendChild(b);
  });

  // recent shots + holes summary
  recentShots.innerHTML = '';

  // hole nav controls
  const navDiv = document.createElement('div');
  navDiv.className = 'row gap';
  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn';
  prevBtn.textContent = '◀ Prev';
  prevBtn.onclick = async ()=>{
    setActiveHoleIndex(CURRENT_ROUND, (CURRENT_ROUND.currentHole || 0) - 1);
    await saveRound(CURRENT_ROUND);
    renderActiveRound();
  };
  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn';
  nextBtn.textContent = 'Next ▶';
  nextBtn.onclick = async ()=>{
    setActiveHoleIndex(CURRENT_ROUND, (CURRENT_ROUND.currentHole || 0) + 1);
    await saveRound(CURRENT_ROUND);
    renderActiveRound();
  };
  const jumpInfo = document.createElement('div');
  jumpInfo.className = 'muted small';
  jumpInfo.style.marginLeft = '8px';
  jumpInfo.textContent = `Hole ${ (CURRENT_ROUND.currentHole||0) + 1 } / ${CURRENT_ROUND.holes.length}`;
  navDiv.appendChild(prevBtn);
  navDiv.appendChild(nextBtn);
  navDiv.appendChild(jumpInfo);
  recentShots.appendChild(navDiv);

  // if viewMode === 'current' show only the active hole card
  if(CURRENT_ROUND.viewMode === 'current'){
    const h = activeHole;
    const strokes = h ? computeHoleStrokes(h) : 0;
    const res = h ? holeResult(h) : 'E';
    const col = document.createElement('div');
    col.className = 'shotItem';
    col.style.padding = '12px';
    col.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>Hole ${h.number}</strong><div class="muted small">Par ${h.par||'-'}</div></div>
      <div style="text-align:right">
        <div style="font-weight:700;font-size:20px">${strokes}</div>
        <div class="muted small">${res}</div>
      </div>
    </div>
    <div class="muted small" style="margin-top:8px">${(h.shots||[]).length} shots • Putts: ${h.putts||0}</div>
    <div style="margin-top:12px" class="row gap">
      <button class="btn" style="flex:1" onclick="openDetailedShotFormByIdSimple()">Add Shot</button>
      <button class="btn" style="flex:1" onclick="advanceHoleAndSave()">Done & Next</button>
    </div>`;
    recentShots.appendChild(col);

    // attach simple helpers for these inline buttons
    window.openDetailedShotFormByIdSimple = function(){
      openDetailedShotForm(CURRENT_ROUND, h);
    };
    window.advanceHoleAndSave = async function(){
      // auto-advance to next hole (if available), otherwise stay
      const idx = CURRENT_ROUND.currentHole || 0;
      if(idx < (CURRENT_ROUND.holes.length - 1)){
        setActiveHoleIndex(CURRENT_ROUND, idx + 1);
        await saveRound(CURRENT_ROUND);
      } else {
        // at last hole: keep as is and alert
        alert('This is the last hole.');
      }
      renderActiveRound();
    };
  } else {
    // viewMode === 'all' -> show full holes grid
    const holesDiv = document.createElement('div');
    holesDiv.style.display = 'grid';
    holesDiv.style.gridTemplateColumns = 'repeat(3,1fr)';
    holesDiv.style.gap = '8px';
    (CURRENT_ROUND.holes || []).forEach((h, idx)=>{
      const strokes = computeHoleStrokes(h);
      const res = holeResult(h);
      const col = document.createElement('div');
      col.className = 'shotItem';
      col.style.padding = '8px';
      if(idx === (CURRENT_ROUND.currentHole || 0)){
        col.style.border = '2px solid var(--primary)';
      }
      col.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>Hole ${h.number}</strong> <div class="muted small">Par ${h.par||'-'}</div></div>
        <div style="text-align:right">
          <div style="font-weight:700">${strokes}</div>
          <div class="muted small">${res}</div>
        </div>
      </div>
      <div class="muted small" style="margin-top:6px">${(h.shots||[]).length} shots • Putts: ${h.putts||0}</div>
      <div style="margin-top:8px">
        <button class="btn" style="padding:8px;font-size:13px" data-r="${CURRENT_ROUND.id}" data-h="${h.id}" onclick="openDetailedShotFormById(this)">Add Shot</button>
      </div>`;
      holesDiv.appendChild(col);
    });
    recentShots.appendChild(holesDiv);
  }

  // total summary
  const summary = document.createElement('div');
  summary.className = 'card';
  summary.style.marginTop = '10px';
  summary.innerHTML = `<div class="row between">
    <div><strong>Round total</strong><div class="muted small">Holes: ${CURRENT_ROUND.holes.length}</div></div>
    <div style="text-align:right"><div style="font-weight:700;font-size:18px">${totals.totalStrokes}</div><div class="muted small">Par ${totals.totalPar} • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}</div></div>
  </div>`;
  recentShots.appendChild(summary);
}

// helper to open detailed shot form when clicked from hole button
window.openDetailedShotFormById = function(btn){
  const rId = btn.getAttribute('data-r');
  const hId = btn.getAttribute('data-h');
  if(!CURRENT_ROUND || CURRENT_ROUND.id !== rId){
    loadAllRounds().then(rounds=>{
      const r = rounds.find(rr=>rr.id===rId);
      if(!r) return alert('Round not found');
      CURRENT_ROUND = r;
      const hole = r.holes.find(x=>x.id===hId);
      const idx = r.holes.findIndex(x=>x.id===hId);
      if(idx >= 0) r.currentHole = idx;
      openDetailedShotForm(r,hole);
    });
  } else {
    const hole = CURRENT_ROUND.holes.find(x=>x.id===hId);
    const idx = CURRENT_ROUND.holes.findIndex(x=>x.id===hId);
    if(idx >= 0) CURRENT_ROUND.currentHole = idx;
    openDetailedShotForm(CURRENT_ROUND,hole);
  }
};

// quick log from favorite
async function quickLogFromFavorite(fav){
  if(!CURRENT_ROUND) return alert('No active round. Start one first.');
  const hole = getActiveHole(CURRENT_ROUND);
  if(!hole) return alert('Active hole not found');
  const shot = {
    id: uid(),
    club: fav.club,
    lie: fav.lie || '',
    slope: fav.slope || '',
    strokeType: fav.stroke || fav.strokeType || 'Full',
    outcome: fav.outcome,
    notes: fav.notes||'',
    ts: new Date().toISOString()
  };
  hole.shots.push(shot);
  await saveRound(CURRENT_ROUND);
  renderActiveRound();
}

// open quick log overlay
function openQuickLog(round){
  if(!round) return alert('No active round. Start one first.');
  overlay.innerHTML = '';
  overlay.classList.remove('hidden');
  const activeHole = getActiveHole(round);
  const form = document.createElement('div');
  form.className = 'form';
  form.innerHTML = `<h3>Quick Log — Hole ${activeHole ? activeHole.number : 1}</h3>
    <div class="smallNote">Tap club → stroke → outcome → lie → slope → Save</div>
    <div style="height:8px"></div>

    <div>
      <label class="small">Club</label>
      <div id="clubGrid" class="pickerGrid"></div>
    </div>
    <div style="height:8px"></div>

    <div>
      <label class="small">Stroke</label>
      <div id="strokeGrid" class="pickerGrid"></div>
    </div>
    <div style="height:8px"></div>

    <div>
      <label class="small">Outcome</label>
      <div id="outGrid" class="pickerGrid"></div>
    </div>
    <div style="height:8px"></div>

    <div>
      <label class="small">Lie (where you hit)</label>
      <div id="lieGrid" class="pickerGrid"></div>
    </div>
    <div style="height:8px"></div>

    <div>
      <label class="small">Slope / Lie type</label>
      <div id="slopeGrid" class="pickerGrid"></div>
    </div>

    <div style="height:8px"></div>
    <input id="noteInput" class="input" placeholder="Short note (e.g. tight lie, wind left)" />
    <div class="row gap" style="margin-top:10px">
      <button id="saveShot" class="btn primary">Save</button>
      <button id="cancelShot" class="btn">Cancel</button>
    </div>`;
  overlay.appendChild(form);

  // build pickers
  const cg = form.querySelector('#clubGrid');
  CFG.clubs.forEach(club=>{
    const b = document.createElement('button'); b.className='pickerBtn'; b.textContent = club; b.onclick = ()=> selectPicker('club',club,b);
    cg.appendChild(b);
  });

  const sg = form.querySelector('#strokeGrid');
  CFG.strokes.forEach(st=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=st; b.onclick=()=>selectPicker('stroke',st,b); sg.appendChild(b); });

  const og = form.querySelector('#outGrid');
  CFG.outcomes.forEach(o=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=o; b.onclick=()=>selectPicker('outcome',o,b); og.appendChild(b); });

  const lg = form.querySelector('#lieGrid');
  CFG.lies.forEach(l=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=l; b.onclick=()=>selectPicker('lie',l,b); lg.appendChild(b); });

  const slg = form.querySelector('#slopeGrid');
  CFG.slopes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>selectPicker('slope',s,b); slg.appendChild(b); });

  // keep track of selections
  const selection = { club: null, stroke: null, outcome: null, lie: null, slope: null };

  function selectPicker(type, value, btn){
    selection[type] = value;
    let gridId = '#clubGrid';
    if(type === 'stroke') gridId = '#strokeGrid';
    else if(type === 'outcome') gridId = '#outGrid';
    else if(type === 'lie') gridId = '#lieGrid';
    else if(type === 'slope') gridId = '#slopeGrid';
    document.querySelectorAll(gridId + ' .pickerBtn').forEach(x=>x.classList.remove('sel'));
    btn.classList.add('sel');
  }

  form.querySelector('#cancelShot').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#saveShot').onclick = async ()=>{
    if(!selection.club || !selection.stroke || !selection.outcome){
      return alert('Select club, stroke and outcome first (three taps).');
    }
    const hole = getActiveHole(round);
    if(!hole) return alert('Active hole not found.');
    const shot = {
      id: uid(),
      club: selection.club,
      strokeType: selection.stroke,
      lie: selection.lie || '',
      slope: selection.slope || '',
      outcome: selection.outcome,
      notes: form.querySelector('#noteInput').value||'',
      ts: new Date().toISOString()
    };
    hole.shots.push(shot);
    await saveRound(round);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

// detailed shot form used by hole buttons (same as before)
function openDetailedShotForm(round,hole){
  overlay.innerHTML = '';
  overlay.classList.remove('hidden');
  const form = document.createElement('div'); form.className = 'form';
  form.innerHTML = `<h3>Shot — Hole ${hole.number}</h3>
    <label class="small">Club <div id="dclub" class="pickerGrid"></div></label>
    <label class="small">Stroke <div id="dstroke" class="pickerGrid"></div></label>
    <label class="small">Lie <div id="dlie" class="pickerGrid"></div></label>
    <label class="small">Slope <div id="dslope" class="pickerGrid"></div></label>
    <label class="small">Outcome <div id="dout" class="pickerGrid"></div></label>
    <input id="notes" class="input" placeholder="Notes (short)">
    <div class="row gap" style="margin-top:10px">
      <button id="save" class="btn primary">Save</button>
      <button id="cancel" class="btn">Cancel</button>
      <button id="addPutt" class="btn">+Putt</button>
    </div>`;
  overlay.appendChild(form);

  const dclub = form.querySelector('#dclub');
  CFG.clubs.forEach(c=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=c; b.onclick=()=>select('club',c,b); dclub.appendChild(b); });
  const dstroke = form.querySelector('#dstroke');
  CFG.strokes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>select('stroke',s,b); dstroke.appendChild(b); });
  const dlie = form.querySelector('#dlie');
  CFG.lies.forEach(l=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=l; b.onclick=()=>select('lie',l,b); dlie.appendChild(b); });
  const dslope = form.querySelector('#dslope');
  CFG.slopes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>select('slope',s,b); dslope.appendChild(b); });
  const dout = form.querySelector('#dout');
  CFG.outcomes.forEach(o=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=o; b.onclick=()=>select('outcome',o,b); dout.appendChild(b); });

  const selection = { club:null, stroke:null, lie:null, slope:null, outcome:null };
  function select(k,v,btn){
    selection[k]=v;
    const gridId = btn.parentElement.id;
    document.querySelectorAll('#'+gridId+' .pickerBtn').forEach(x=>x.classList.remove('sel'));
    btn.classList.add('sel');
  }

  form.querySelector('#cancel').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#addPutt').onclick = async ()=>{
    hole.putts = (hole.putts||0) + 1;
    await saveRound(round);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
  form.querySelector('#save').onclick = async ()=>{
    if(!selection.club || !selection.stroke || !selection.outcome){
      return alert('Select club, stroke and outcome first.');
    }
    const shot = {
      id: uid(),
      club: selection.club,
      strokeType: selection.stroke,
      lie: selection.lie || '',
      slope: selection.slope || '',
      outcome: selection.outcome,
      notes: form.querySelector('#notes').value || '',
      ts: new Date().toISOString()
    };
    hole.shots.push(shot);
    await saveRound(round);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

// settings UI
function openSettings(){
  overlay.innerHTML = ''; overlay.classList.remove('hidden');
  const cfg = getConfig();
  const form = document.createElement('div'); form.className='form';
  form.innerHTML = `<h3>Settings</h3>
    <div class="smallNote">Edit your club list, lie list, slope list and favorites. Favorites appear on the main screen for one-tap logging.</div>
    <div style="height:8px"></div>

    <label class="small">Clubs (comma separated)</label>
    <textarea id="clubsText" style="width:100%;min-height:60px;border-radius:10px;padding:8px">${cfg.clubs.join(', ')}</textarea>

    <div style="height:8px"></div>
    <label class="small">Lies (comma separated)</label>
    <textarea id="liesText" style="width:100%;min-height:60px;border-radius:10px;padding:8px">${cfg.lies.join(', ')}</textarea>

    <div style="height:8px"></div>
    <label class="small">Slopes / Lie types (comma separated)</label>
    <textarea id="slopesText" style="width:100%;min-height:60px;border-radius:10px;padding:8px">${cfg.slopes.join(', ')}</textarea>

    <div style="height:8px"></div>
    <label class="small">Favorites (one per line, format: label | club | outcome | lie | stroke )</label>
    <textarea id="favText" style="width:100%;min-height:120px;border-radius:10px;padding:8px">${(cfg.favorites||[]).map(f=>`${f.label}|${f.club}|${f.outcome}|${f.lie||''}|${f.stroke||''}`).join('\n')}</textarea>

    <div class="row gap" style="margin-top:10px">
      <button id="saveCfg" class="btn primary">Save</button>
      <button id="closeCfg" class="btn">Close</button>
    </div>`;
  overlay.appendChild(form);
  form.querySelector('#closeCfg').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#saveCfg').onclick = ()=> {
    const clubs = form.querySelector('#clubsText').value.split(',').map(s=>s.trim()).filter(Boolean);
    const lies = form.querySelector('#liesText').value.split(',').map(s=>s.trim()).filter(Boolean);
    const slopes = form.querySelector('#slopesText').value.split(',').map(s=>s.trim()).filter(Boolean);
    const favLines = form.querySelector('#favText').value.split('\n').map(l=>l.trim()).filter(Boolean);
    const favorites = favLines.map(line=>{
      const parts = line.split('|').map(p=>p.trim());
      return { label: parts[0]||`${parts[1]||''} ${parts[2]||''}`, club: parts[1]||'', outcome: parts[2]||'', lie: parts[3]||'', stroke: parts[4]||'' };
    });
    CFG.clubs = clubs.length? clubs : DEFAULTS.clubs;
    CFG.lies = lies.length? lies : DEFAULTS.lies;
    CFG.slopes = slopes.length? slopes : DEFAULTS.slopes;
    CFG.favorites = favorites.length? favorites : DEFAULTS.favorites;
    saveConfig(CFG);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

// init
(async function init(){
  // set default date field to today
  const d = new Date().toISOString().slice(0,10);
  document.getElementById('roundDate').value = d;

  // attach main listeners
  document.getElementById('menuBtn').onclick = ()=> openSettings();

  // register service worker
  if('serviceWorker' in navigator){
    try{
      await navigator.serviceWorker.register('/sw.js');
      console.log('sw registered');
    }catch(e){
      console.warn('sw register failed',e);
    }
  }

  // inject 'Use Local Course' button
  injectLocalCourseButton();

  await renderRoundsList();
  renderActiveRound();
})();
