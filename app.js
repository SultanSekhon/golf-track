/* GolfTrack PWA - app.js (UPDATED: Local course opens in compact current-hole view by default)
   - new round.viewMode: 'current' or 'all'
   - toggle button in active header to switch views
   - auto-mark first shot of hole as tee shot
   - full PGA penalty system (multiple penalty types) with UI
   - View Scorecard with penalties and CSV export
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
  lies: ['Tee','Fairway','Rough','Deep Rough','Bunker','Green','Fringe','Woods','Hazard','Other'],
  strokes: ['Full','Pitch','Chip','Bunker','Putt'],
  outcomes: ['Good','Thin','Fat','Topped','Chunk','Hook','Slice','Push','Pull','Shank','Skull','Bladed','Duff','Other'],
  slopes: ['Flat','Uphill','Downhill','Ball Above Feet','Ball Below Feet','Tight Lie','Plugged','Other'],
  favorites: [
    // Default favorites removed - user can add their own
  ],
  // penalty types and their default penalty stroke count (PGA simplified)
  penaltyTypes: [
    { key: 'Lost Ball', label: 'Lost Ball (stroke-and-distance)', strokes: 1 },
    { key: 'Out of Bounds', label: 'Out of Bounds (stroke-and-distance)', strokes: 1 },
    { key: 'Water Hazard', label: 'Water Hazard', strokes: 1 },
    { key: 'Penalty Area', label: 'Penalty Area', strokes: 1 },
    { key: 'Unplayable', label: 'Unplayable (player-declared)', strokes: 1 },
    { key: 'Other', label: 'Other', strokes: 1 }
  ],
  // new setting: whether to apply PGA stroke-and-distance behavior for lost ball (used as a hint)
  pgaLostBall: true
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
// close overlay when tapping the dim backdrop
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  }
});

// close overlay with Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  }
});

const activeRoundSection = $('activeRound');
const roundTitle = $('roundTitle');
const roundMeta = $('roundMeta');
const recentShots = $('recentShots');
const quickFavorites = $('quickFavorites');

let CURRENT_ROUND = null;

// --- Helper functions ---
function createHole(number, par = 4) {
  return {
    id: uid(),
    number,
    par,
    shots: [],
    putts: 0,
    penalties: []
  };
}

function createRound(course, date, viewMode = 'all') {
  return {
    id: uid(),
    date,
    course,
    holes: [],
    notes: '',
    createdAt: new Date().toISOString(),
    currentHole: 0,
    viewMode
  };
}

function createShot(club, strokeType, outcome, lie = '', slope = '', notes = '') {
  return {
    id: uid(),
    club,
    strokeType,
    lie,
    slope,
    outcome,
    notes,
    ts: new Date().toISOString()
  };
}

function createPenalty(type, strokes = 1, note = '') {
  return {
    id: uid(),
    type,
    strokes,
    note,
    ts: new Date().toISOString()
  };
}

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
  // penalties: sum the strokes field of each penalty entry
  const penalties = (hole.penalties && hole.penalties.length) ? hole.penalties.reduce((acc,p)=>acc + (p.strokes||1), 0) : 0;
  // total strokes is shots + penalty strokes + any extra putts minus putt entries (because extraPutts already counted separately)
  const strokes = totalShotEntries + extraPutts + penalties - puttShots;
  return Math.max(strokes, totalShotEntries + penalties);
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

// compute FIR (Fairway in Regulation) - approach shots hit fairway before reaching green
function computeFIR(hole){
  const par = hole.par || 0;
  if(par <= 3) return false; // No FIR on par 3s
  if(!hole.shots || hole.shots.length === 0) return false;
  
  // For par 4: check if 2nd shot (approach) hits fairway
  if(par === 4) {
    const secondShot = hole.shots[1];
    return secondShot && secondShot.lie === 'Fairway';
  }
  
  // For par 5: check if 2nd shot hits fairway (required for FIR)
  if(par === 5) {
    const secondShot = hole.shots[1];
    return secondShot && secondShot.lie === 'Fairway';
  }
  
  return false;
}

// compute GIR (Green in Regulation) - reach green in regulation shots
function computeGIR(hole){
  const par = hole.par || 0;
  if(par === 0) return false;
  
  const shots = hole.shots || [];
  const puttShots = shots.filter(s => (s.strokeType||'').toLowerCase() === 'putt');
  const nonPuttShots = shots.length - puttShots.length;
  
  // GIR means reaching green in regulation shots:
  // Par 3: 1 shot to reach green
  // Par 4: 2 shots to reach green  
  // Par 5: 3 shots to reach green
  if(par === 3) return nonPuttShots === 1;
  if(par === 4) return nonPuttShots === 2;
  if(par === 5) return nonPuttShots === 3;
  
  return false;
}

// compute 2-putt (0, 1, or 2 putts - all are good putting)
function compute2Putt(hole){
  const putts = hole.putts || 0;
  return putts === 0 || putts === 1 || putts === 2;
}

// --- UI: Use Local Course button (already exists in HTML) ---
// No need to inject - button already exists in HTML

// create round pre-filled with LOCAL_COURSE (compact view by default)
async function createLocalCourseRound(){
  const r = createRound(LOCAL_COURSE.name, new Date().toISOString().slice(0,10), 'current');
  
  for(let i = 0; i < LOCAL_COURSE.pars.length; i++){
    r.holes.push(createHole(i + 1, LOCAL_COURSE.pars[i]));
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
  const r = createRound(course, date, 'all');
  r.holes.push(createHole(1, 4));
  await saveRound(r);
  CURRENT_ROUND = r;
  renderActiveRound();
  renderRoundsList();
});

// Use Local Course button event listener
$('useLocalCourseBtn').addEventListener('click', createLocalCourseRound);

// Quick Log button removed - Add Shot button handles this functionality
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
  CURRENT_ROUND.holes.push(createHole(holeNumber, 4));
  setActiveHoleIndex(CURRENT_ROUND, CURRENT_ROUND.holes.length - 1);
  CURRENT_ROUND.viewMode = 'current';
  await saveRound(CURRENT_ROUND);
  renderActiveRound();
});

// export CSV (includes par & strokes & currentHole)
$('exportBtn').addEventListener('click', async ()=>{
  const rounds = await loadAllRounds();
  if(!rounds.length){ alert('No rounds to export'); return; }
  const rows = [['round_id','date','course','hole','par','shot_id','club','stroke','lie','slope','outcome','notes','timestamp','strokes','putts','penalties','shot_is_tee','fir','gir','2putt','currentHoleIndex','viewMode']];
  rounds.forEach(r=>{
    r.holes.forEach(h=>{
      const strokes = computeHoleStrokes(h);
      const fir = computeFIR(h) ? '1' : '0';
      const gir = computeGIR(h) ? '1' : '0';
      const twoPutt = compute2Putt(h) ? '1' : '0';
      
      if(h.shots && h.shots.length){
        h.shots.forEach(s=>{
          // Handle multiple outcomes in CSV
          const outcome = s.outcome || '';
          rows.push([r.id, r.date, r.course, h.number, h.par || '', s.id, s.club, s.strokeType, s.lie || '', s.slope || '', outcome, (s.notes||''), s.ts, strokes, h.putts||0, (h.penalties? h.penalties.length:0), (s.isTee? '1':'0'), fir, gir, twoPutt, r.currentHole||0, r.viewMode||'all']);
        });
      } else {
        rows.push([r.id, r.date, r.course, h.number, h.par || '', '', '', '', '', '', '', '', '', strokes, h.putts||0, (h.penalties? h.penalties.length:0), '0', fir, gir, twoPutt, r.currentHole||0, r.viewMode||'all']);
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
  // Insert the rounds list once
  createCard.insertAdjacentElement('afterend', listRoot);

  // Button already exists in HTML - no need to inject

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

  // header meta + view toggle + view scorecard
  const viewToggleText = (CURRENT_ROUND.viewMode === 'current') ? 'Show all holes' : 'Show current hole';
  roundMeta.innerHTML = `Date ${CURRENT_ROUND.date} • ${CURRENT_ROUND.holes.length} hole(s) • Total: ${totals.totalStrokes} (Par ${totals.totalPar}) • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}
    <div style="margin-top:6px">
      <button id="toggleViewBtn" class="btn" style="padding:8px;font-size:13px">${viewToggleText}</button>
      <button id="viewScorecardBtn" class="btn" style="padding:8px;font-size:13px;margin-left:8px">View Scorecard</button>
    </div>`;

  // attach toggle handler (delegated after DOM insertion)
  setTimeout(()=> {
    const tbtn = document.getElementById('toggleViewBtn');
    if(tbtn) tbtn.onclick = async ()=>{
      CURRENT_ROUND.viewMode = (CURRENT_ROUND.viewMode === 'current') ? 'all' : 'current';
      await saveRound(CURRENT_ROUND);
      renderActiveRound();
    };
    const scbtn = document.getElementById('viewScorecardBtn');
    if(scbtn) scbtn.onclick = ()=> openScorecardOverlay(CURRENT_ROUND);
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
    // penalties count & list
    const penCount = (h && h.penalties) ? h.penalties.length : 0;
    const penList = (h && h.penalties && h.penalties.length) ? h.penalties.map(p=>`${p.type}${p.note?(' ('+p.note+')') : ''}`).join(', ') : 'None';
    col.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>Hole ${h.number}</strong><div class="muted small">Par ${h.par||'-'}</div></div>
      <div style="text-align:right">
        <div style="font-weight:700;font-size:20px">${strokes}</div>
        <div class="muted small">${res}</div>
      </div>
    </div>
    <div class="muted small" style="margin-top:8px">${(h.shots||[]).length} shots • Putts: ${h.putts||0} • Penalties: ${penCount}</div>
    <div class="muted small" style="margin-top:6px">Penalties: ${penList}</div>
    <div style="margin-top:12px" class="row gap">
      <button class="add-shot-btn" onclick="openDetailedShotFormByIdSimple()">Add Shot</button>
      <button class="done-next-btn" onclick="advanceHoleAndSave()">Done & Next</button>
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
      const penCount = (h.penalties? h.penalties.length : 0);
      col.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>Hole ${h.number}</strong> <div class="muted small">Par ${h.par||'-'}</div></div>
        <div style="text-align:right">
          <div style="font-weight:700">${strokes}</div>
          <div class="muted small">${res}</div>
        </div>
      </div>
      <div class="muted small" style="margin-top:6px">${(h.shots||[]).length} shots • Putts: ${h.putts||0} • Penalties: ${penCount}</div>
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
  
  const shot = createShot(
    fav.club,
    fav.stroke || fav.strokeType || 'Full',
    fav.outcome,
    fav.lie || '',
    fav.slope || '',
    fav.notes || ''
  );
  
  // mark tee if first shot on hole
  hole.shots = hole.shots || [];
  if(!hole.shots.length){
    shot.isTee = true;
    shot.lie = 'Tee';  // Always tee for first shot
    shot.slope = 'Flat';  // Always flat for first shot
  }
  hole.shots.push(shot);
  hole.penalties = hole.penalties || [];
  await saveRound(CURRENT_ROUND);
  renderActiveRound();
}

// Quick Log function removed - Add Shot button handles this functionality

// detailed shot form used by hole buttons (same as before)
function openDetailedShotForm(round,hole){
  overlay.innerHTML = '';
  overlay.classList.remove('hidden');
  const form = document.createElement('div'); form.className = 'form';
  
  // Check if this is the first shot on the hole
  const isFirstShot = !hole.shots || hole.shots.length === 0;
  const par = hole.par || 4;
  
  // Smart club recommendations based on par
  let recommendedClubs = [];
  if(isFirstShot) {
    if(par <= 3) {
      // Par 3: 6i to GW
      recommendedClubs = ['6-iron', '7-iron', '8-iron', '9-iron', 'PW', 'GW'];
    } else {
      // Par 4/5: Driver to 4-iron
      recommendedClubs = ['Driver', '3-wood', '5-wood', '3-iron', '4-iron'];
    }
  }
  
  // build penalty options html for select in the form
  let penaltyOptionsHTML = '';
  (CFG.penaltyTypes || []).forEach(p=>{
    penaltyOptionsHTML += `<option value="${p.key}">${p.label}${p.strokes?(' (+'+p.strokes+')') : ''}</option>`;
  });

  // Show existing shots if any
  const existingShotsHTML = (hole.shots && hole.shots.length) ? 
    `<div style="margin-bottom:16px">
      <label class="small">Existing Shots (click to edit)</label>
      <div id="existingShots" style="max-height:200px;overflow-y:auto;border:1px solid #ddd;border-radius:8px;padding:8px">
        ${hole.shots.map((shot, idx) => `
          <div class="shot-item" style="display:flex;justify-content:space-between;align-items:center;padding:6px;border-bottom:1px solid #eee;cursor:pointer" data-shot-id="${shot.id}">
            <div>
              <strong>${shot.club}</strong> • ${shot.strokeType} • ${shot.outcome}
              <div class="muted small">${shot.lie} • ${shot.slope} ${shot.notes ? '• ' + shot.notes : ''}</div>
            </div>
            <div>
              <button class="btn small" onclick="editShot('${shot.id}')" style="padding:4px 8px;font-size:12px">Edit</button>
              <button class="btn small danger" onclick="deleteShot('${shot.id}')" style="padding:4px 8px;font-size:12px;margin-left:4px">×</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>` : '';

  form.innerHTML = `<h3>Shot — Hole ${hole.number} (Par ${par})</h3>
    ${existingShotsHTML}
    <label class="small">Club ${isFirstShot ? `(${par <= 3 ? 'Par 3' : 'Par 4/5'} recommendations)` : ''} <div id="dclub" class="pickerGrid"></div></label>
    <label class="small">Stroke <div id="dstroke" class="pickerGrid"></div></label>
    <label class="small">Lie <div id="dlie" class="pickerGrid"></div></label>
    <label class="small">Slope <div id="dslope" class="pickerGrid"></div></label>
    <label class="small">Outcome <div id="dout" class="pickerGrid"></div></label>
    <input id="notes" class="input" placeholder="Notes (short)">
    <div style="height:8px"></div>
    <div>
      <label class="small">Add Penalty</label>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="penaltySelect" class="input" style="flex:1">
          ${penaltyOptionsHTML}
        </select>
        <input id="penaltyNote" class="input" placeholder="Note (optional)" style="width:160px"/>
        <button id="addPenaltyBtn" class="btn">Add Penalty</button>
      </div>
      <div class="muted small" id="penList" style="margin-top:6px">${(hole.penalties && hole.penalties.length)? hole.penalties.map(p=>p.type+(p.note?(' ('+p.note+')') : '')).join(', '): 'No penalties'}</div>
    </div>

    <div class="row gap" style="margin-top:10px">
      <button id="save" class="btn primary">Add Shot</button>
      <button id="cancel" class="btn">Cancel</button>
      <button id="addPutt" class="btn">+Putt</button>
      <button id="lostBall" class="btn" title="PGA: stroke-and-distance">Lost Ball (PGA)</button>
    </div>`;
  overlay.appendChild(form);

  // ---------- FIX: helper to find picker buttons by visible text ----------
  function findBtnByText(containerEl, txt) {
    if (!containerEl) return null;
    const needle = String(txt || '').trim().toLowerCase();
    const btns = containerEl.querySelectorAll('button.pickerBtn');
    for (const b of btns) {
      if (b.textContent.trim().toLowerCase() === needle) return b;
    }
    return null;
  }
  // -----------------------------------------------------------------------

  const dclub = form.querySelector('#dclub');
  
  // Smart club selection for first shots
  if(isFirstShot && recommendedClubs.length > 0) {
    // Show recommended clubs first
    recommendedClubs.forEach(c=>{ 
      if(CFG.clubs.includes(c)) {
        const b=document.createElement('button'); 
        b.className='pickerBtn recommended'; 
        b.textContent=c; 
        b.onclick=()=>select('club',c,b); 
        dclub.appendChild(b); 
      }
    });
    
    // Add "More" button to show all clubs
    const moreBtn = document.createElement('button');
    moreBtn.className = 'pickerBtn more-btn';
    moreBtn.textContent = 'More...';
    moreBtn.onclick = () => {
      moreBtn.style.display = 'none';
      // Show remaining clubs
      CFG.clubs.forEach(c => {
        if(!recommendedClubs.includes(c)) {
          const b = document.createElement('button');
          b.className = 'pickerBtn';
          b.textContent = c;
          b.onclick = () => select('club', c, b);
          dclub.appendChild(b);
        }
      });
    };
    dclub.appendChild(moreBtn);
  } else {
    // Show all clubs for non-first shots
    CFG.clubs.forEach(c=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=c; b.onclick=()=>select('club',c,b); dclub.appendChild(b); });
  }
  const dstroke = form.querySelector('#dstroke');
  CFG.strokes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>select('stroke',s,b); dstroke.appendChild(b); });
  const dlie = form.querySelector('#dlie');
  
  // Filter lies based on shot number and penalties
  let availableLies = CFG.lies;
  if(!isFirstShot) {
    // Check if there are any penalties in the hole
    const hasPenalties = hole.penalties && hole.penalties.length > 0;
    if(!hasPenalties) {
      // Remove 'Tee' option for non-first shots unless there are penalties
      availableLies = CFG.lies.filter(lie => lie !== 'Tee');
    }
  }
  
  availableLies.forEach(l=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=l; b.onclick=()=>select('lie',l,b); dlie.appendChild(b); });
  const dslope = form.querySelector('#dslope');
  CFG.slopes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>select('slope',s,b); dslope.appendChild(b); });
  
  // Auto-select and lock tee lie and flat slope for first shots only
  if(isFirstShot) {
    setTimeout(() => {
      const teeBtn = dlie.querySelector('button');
      if(teeBtn && teeBtn.textContent === 'Tee') {
        select('lie', 'Tee', teeBtn);
        dlie.querySelectorAll('button').forEach(btn => {
          btn.style.pointerEvents = 'none';
          btn.style.opacity = '0.5';
        });
        teeBtn.style.pointerEvents = 'auto';
        teeBtn.style.opacity = '1';
      }
    }, 200);
    setTimeout(() => {
      const flatBtn = dslope.querySelector('button');
      if(flatBtn && flatBtn.textContent === 'Flat') {
        select('slope', 'Flat', flatBtn);
        dslope.querySelectorAll('button').forEach(btn => {
          btn.style.pointerEvents = 'none';
          btn.style.opacity = '0.5';
        });
        flatBtn.style.pointerEvents = 'auto';
        flatBtn.style.opacity = '1';
      }
    }, 200);
  }
  const dout = form.querySelector('#dout');
  CFG.outcomes.forEach(o=>{ 
    const b=document.createElement('button'); 
    b.className='pickerBtn'; 
    b.textContent=o; 
    b.onclick=()=>selectMultiple('outcome',o,b); 
    dout.appendChild(b); 
  });

  const selection = { club:null, stroke:null, lie:null, slope:null, outcome:[] };
  function select(k,v,btn){
    selection[k]=v;
    const gridId = btn.parentElement.id;
    document.querySelectorAll('#'+gridId+' .pickerBtn').forEach(x=>x.classList.remove('sel'));
    btn.classList.add('sel');
  }
  
  function selectMultiple(k,v,btn){
    if(!selection[k]) selection[k] = [];
    const index = selection[k].indexOf(v);
    if(index > -1) {
      selection[k].splice(index, 1);
      btn.classList.remove('sel');
    } else {
      selection[k].push(v);
      btn.classList.add('sel');
    }
  }

  form.querySelector('#cancel').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#addPutt').onclick = async ()=>{
    hole.putts = (hole.putts||0) + 1;
    await saveRound(round);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };

  hole.penalties = hole.penalties || [];

  form.querySelector('#addPenaltyBtn').onclick = async ()=>{
    const sel = form.querySelector('#penaltySelect').value;
    const note = form.querySelector('#penaltyNote').value||'';
    const pt = (CFG.penaltyTypes || []).find(x=>x.key === sel);
    if(!pt) return alert('Invalid penalty selected');
    hole.penalties.push(createPenalty(pt.key, pt.strokes || 1, note));
    await saveRound(round);
    form.querySelector('#penList').textContent = hole.penalties.map(p=>p.type+(p.note?(' ('+p.note+')') : '')).join(', ');
    form.querySelector('#penaltyNote').value = '';
    renderActiveRound();
  };

  form.querySelector('#lostBall').onclick = async ()=>{
    if(!CFG.pgaLostBall){
      if(!confirm('PGA lost-ball handling is currently disabled in Settings. Add penalty anyway?')) return;
    }

    const pt = (CFG.penaltyTypes || []).find(x=>x.key==='Lost Ball') || (CFG.penaltyTypes||[])[0];
    hole.penalties.push(createPenalty(pt.key, pt.strokes || 1, 'Lost ball recorded'));
    await saveRound(round);
    alert('Lost Ball recorded: +1 penalty stroke (stroke-and-distance). You should replay from the appropriate previous spot/tee as required by the rules.');
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };

  form.querySelector('#save').onclick = async ()=>{
    if(!selection.club || !selection.stroke || !selection.outcome || selection.outcome.length === 0){
      return alert('Select club, stroke and at least one outcome first.');
    }
    hole.penalties = hole.penalties || [];
    const shot = createShot(
      selection.club,
      selection.stroke,
      Array.isArray(selection.outcome) ? selection.outcome.join(', ') : selection.outcome,
      selection.lie || '',
      selection.slope || '',
      form.querySelector('#notes').value || ''
    );
    hole.shots = hole.shots || [];
    if(!hole.shots.length){
      shot.isTee = true;
      shot.lie = 'Tee';
      shot.slope = 'Flat';
      selection.lie = 'Tee';
      selection.slope = 'Flat';
    }
    hole.shots.push(shot);
    await saveRound(round);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };

  window.editShot = async function(shotId) {
    const shot = hole.shots.find(s => s.id === shotId);
    if (!shot) return;

    const clubBtn  = findBtnByText(dclub,  shot.club);
    if (clubBtn) select('club', shot.club, clubBtn);
    
    const strokeBtn = findBtnByText(dstroke, shot.strokeType);
    if (strokeBtn) select('stroke', shot.strokeType, strokeBtn);
    
    const lieBtn   = findBtnByText(dlie,   shot.lie);
    if (lieBtn) select('lie', shot.lie, lieBtn);
    
    const slopeBtn = findBtnByText(dslope, shot.slope);
    if (slopeBtn) select('slope', shot.slope, slopeBtn);

    const outcomes = Array.isArray(shot.outcome)
      ? shot.outcome
      : String(shot.outcome || '').split(',').map(s => s.trim()).filter(Boolean);
    outcomes.forEach(o => {
      const ob = findBtnByText(dout, o);
      if (ob) selectMultiple('outcome', o, ob);
    });
    
    form.querySelector('#notes').value = shot.notes || '';

    const saveBtn = form.querySelector('#save');
    saveBtn.textContent = 'Update Shot';
    saveBtn.onclick = async () => {
      if(!selection.club || !selection.stroke || !selection.outcome || selection.outcome.length === 0){
        return alert('Select club, stroke and at least one outcome first.');
      }
      
      shot.club = selection.club;
      shot.strokeType = selection.stroke;
      shot.lie = selection.lie || '';
      shot.slope = selection.slope || '';
      shot.outcome = Array.isArray(selection.outcome) ? selection.outcome.join(', ') : (selection.outcome || '');
      shot.notes = form.querySelector('#notes').value || '';
      shot.ts = new Date().toISOString();
      
      await saveRound(round);
      overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
    };
  };

  window.deleteShot = async function(shotId) {
    if (!confirm('Delete this shot?')) return;
    
    hole.shots = hole.shots.filter(s => s.id !== shotId);
    await saveRound(round);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

function openSettings(){
  overlay.innerHTML = ''; overlay.classList.remove('hidden');
  const cfg = getConfig();
  const form = document.createElement('div'); form.className='form';
  form.innerHTML = `<h3>Settings</h3>
    <div class="smallNote">Edit your club list, lie list, slope list and favorites. Favorites appear on the main screen for one-tap logging. Edit penalty types below to reflect PGA options.</div>
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

    <div style="height:8px"></div>
    <label class="small">Penalty Types (one per line, format: key | label | strokes)</label>
    <textarea id="penText" style="width:100%;min-height:120px;border-radius:10px;padding:8px">${(cfg.penaltyTypes||[]).map(p=>`${p.key}|${p.label}|${p.strokes||1}`).join('\n')}</textarea>

    <div style="height:8px"></div>
    <label class="small">PGA Lost Ball Handling</label>
    <div>
      <label><input type="checkbox" id="pgaLostChk"> Use PGA stroke-and-distance for lost ball penalties (records +1 penalty stroke)</label>
    </div>

    <div class="row gap" style="margin-top:10px">
      <button id="saveCfg" class="btn primary">Save</button>
      <button id="closeCfg" class="btn">Close</button>
    </div>`;
  overlay.appendChild(form);
  form.querySelector('#closeCfg').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };

  form.querySelector('#pgaLostChk').checked = !!cfg.pgaLostBall;

  form.querySelector('#saveCfg').onclick = ()=> {
    const clubs = form.querySelector('#clubsText').value.split(',').map(s=>s.trim()).filter(Boolean);
    const lies = form.querySelector('#liesText').value.split(',').map(s=>s.trim()).filter(Boolean);
    const slopes = form.querySelector('#slopesText').value.split(',').map(s=>s.trim()).filter(Boolean);
    const favLines = form.querySelector('#favText').value.split('\n').map(l=>l.trim()).filter(Boolean);
    const favorites = favLines.map(line=>{
      const parts = line.split('|').map(p=>p.trim());
      return { label: parts[0]||`${parts[1]||''} ${parts[2]||''}`, club: parts[1]||'', outcome: parts[2]||'', lie: parts[3]||'', stroke: parts[4]||'' };
    });

    const penLines = form.querySelector('#penText').value.split('\n').map(l=>l.trim()).filter(Boolean);
    const penaltyTypes = penLines.map(line=>{
      const parts = line.split('|').map(p=>p.trim());
      return { key: parts[0] || parts[1] || 'Other', label: parts[1] || parts[0] || 'Other', strokes: Number(parts[2]) || 1 };
    });

    CFG.clubs = clubs.length? clubs : DEFAULTS.clubs;
    CFG.lies = lies.length? lies : DEFAULTS.lies;
    CFG.slopes = slopes.length? slopes : DEFAULTS.slopes;
    CFG.favorites = favorites.length? favorites : DEFAULTS.favorites;
    CFG.penaltyTypes = penaltyTypes.length? penaltyTypes : DEFAULTS.penaltyTypes;
    CFG.pgaLostBall = !!form.querySelector('#pgaLostChk').checked;
    saveConfig(CFG);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

(async function init(){

  const d = new Date().toISOString().slice(0,10);
  document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  }
});
  document.getElementById('roundDate').value = d;

  document.getElementById('menuBtn').onclick = ()=> openSettings();

  if('serviceWorker' in navigator){
    try{
      await navigator.serviceWorker.register('./sw.js');
      console.log('sw registered');
    }catch(e){
      console.warn('sw register failed',e);
    }
  }

  await renderRoundsList();
  renderActiveRound();
})();

function openScorecardOverlay(round){
  if(!round) return alert('No active round');
  overlay.innerHTML = '';
  overlay.classList.remove('hidden');

  const totals = computeRoundTotals(round);
  const div = document.createElement('div');
  div.className = 'form';

  let html = `
    <h3>Scorecard — ${round.course} (${round.date})</h3>
    <div class="muted small">Total: ${totals.totalStrokes} • Par ${totals.totalPar} • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}</div>
    <div class="muted small">FIR: ${
      round.holes.filter(computeFIR).length
    }/${round.holes.length} • GIR: ${
      round.holes.filter(computeGIR).length
    }/${round.holes.length} • 2-Putts: ${
      round.holes.filter(compute2Putt).length
    }</div>
    <div style="height:12px"></div>

    <table>
      <thead>
        <tr>
          <th>Hole</th>
          <th>Par</th>
          <th>Strokes</th>
          <th>Putts</th>
          <th>FIR</th>
          <th>GIR</th>
          <th>2-Putt</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
  `;

  (round.holes || []).forEach(h=>{
    const strokes = computeHoleStrokes(h);
    const res = holeResult(h);
    const fir = computeFIR(h) ? '✓' : '✗';
    const gir = computeGIR(h) ? '✓' : '✗';
    const twoPutt = compute2Putt(h) ? '✓' : '✗';

    html += `
      <tr>
        <td>${h.number}</td>
        <td>${h.par || '-'}</td>
        <td>${strokes}</td>
        <td>${h.putts || 0}</td>
        <td>${fir}</td>
        <td>${gir}</td>
        <td>${twoPutt}</td>
        <td>${res}</td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>

    <div style="height:10px"></div>
    <div class="row gap">
      <button id="closeScorecard" class="btn">Close</button>
      <button id="exportScorecardCSV" class="btn">Export CSV</button>
    </div>
  `;

  div.innerHTML = html;
  overlay.appendChild(div);

  document.getElementById('closeScorecard').onclick = ()=>{
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  };

  document.getElementById('exportScorecardCSV').onclick = ()=>{
    const rows = [['hole','par','strokes','putts','penalties','fir','gir','2putt','result']];
    (round.holes||[]).forEach(h=>{
      const strokes = computeHoleStrokes(h);
      const fir = computeFIR(h) ? 'Yes' : 'No';
      const gir = computeGIR(h) ? 'Yes' : 'No';
      const twoPutt = compute2Putt(h) ? 'Yes' : 'No';
      rows.push([h.number, h.par||'', strokes, h.putts||0, (h.penalties? h.penalties.length:0), fir, gir, twoPutt, holeResult(h)]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `golftrack_scorecard_${round.date}_${round.course.replace(/\s+/g,'_')}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
}




