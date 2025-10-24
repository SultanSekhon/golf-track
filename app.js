/* GolfTrack PWA - app.js (UPDATED)
   - Edit shot support (edit/delete)
   - Tee-shot quick guide (no lie asked on tee; lie stored as "Tee")
   - Minor UI streamline for current-hole view
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
  lies: ['Fairway','Rough','Deep Rough','Bunker','Green','Fringe','Woods','Hazard','Tee','Other'],
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
    4,3,4,3,5,4,5,4,4,
    4,4,5,3,4,5,4,3,4
  ]
};

// format helpers
function timeShort(iso){
  return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

// --- active hole helpers ---
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
function computeRoundTotals(round){
  const holes = round.holes || [];
  let totalPar = 0, totalStrokes = 0;
  holes.forEach(h=>{ totalPar += (h.par||0); totalStrokes += computeHoleStrokes(h); });
  return { totalPar, totalStrokes, diff: totalStrokes - totalPar };
}

// inject local course button
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

// create local course round (compact view)
async function createLocalCourseRound(){
  const r = { id: uid(), date: new Date().toISOString().slice(0,10), course: LOCAL_COURSE.name, holes: [], notes:'', createdAt:new Date().toISOString(), currentHole:0, viewMode:'current' };
  for(let i=0;i<LOCAL_COURSE.pars.length;i++){
    r.holes.push({ id: uid(), number: i+1, par: LOCAL_COURSE.pars[i], shots: [], putts: 0 });
  }
  await saveRound(r);
  CURRENT_ROUND = r;
  renderActiveRound();
  renderRoundsList();
}

// create manual round
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

// listeners
$('quickLogBtn').addEventListener('click', ()=> openQuickLog(CURRENT_ROUND));
$('navSettings').addEventListener('click', ()=> openSettings());
$('endRoundBtn').addEventListener('click', async ()=>{
  if(!CURRENT_ROUND) return;
  if(!confirm('End round and save?')) return;
  CURRENT_ROUND = null;
  renderActiveRound();
  renderRoundsList();
});
$('addHoleBtn').addEventListener('click', async ()=>{
  if(!CURRENT_ROUND) return;
  if((CURRENT_ROUND.holes||[]).length >= 18) return alert('Maximum 18 holes reached.');
  const holeNumber = (CURRENT_ROUND.holes.length || 0) + 1;
  CURRENT_ROUND.holes.push({ id: uid(), number: holeNumber, par:4, shots:[], putts:0 });
  setActiveHoleIndex(CURRENT_ROUND, CURRENT_ROUND.holes.length - 1);
  CURRENT_ROUND.viewMode = 'current';
  await saveRound(CURRENT_ROUND);
  renderActiveRound();
});

// export CSV
$('exportBtn').addEventListener('click', async ()=>{
  const rounds = await loadAllRounds();
  if(!rounds.length){ alert('No rounds to export'); return; }
  const rows = [['round_id','date','course','hole','par','shot_id','club','stroke','lie','slope','outcome','notes','timestamp','strokes','putts']];
  rounds.forEach(r=>{
    r.holes.forEach(h=>{
      const strokes = computeHoleStrokes(h);
      if(h.shots && h.shots.length){
        h.shots.forEach(s=>{
          rows.push([r.id, r.date, r.course, h.number, h.par || '', s.id, s.club, s.strokeType, s.lie || '', s.slope || '', s.outcome, (s.notes||''), s.ts, strokes, h.putts||0]);
        });
      } else {
        rows.push([r.id, r.date, r.course, h.number, h.par || '', '', '', '', '', '', '', '', '', strokes, h.putts||0]);
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

// render rounds list
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
  if(!CURRENT_ROUND && rounds.length) {
    CURRENT_ROUND = rounds[0];
    renderActiveRound();
  }
}

// render active round (respects viewMode)
function renderActiveRound(){
  if(!CURRENT_ROUND){
    activeRoundSection.classList.add('hidden');
    return;
  }
  activeRoundSection.classList.remove('hidden');
  if(typeof CURRENT_ROUND.currentHole !== 'number') CURRENT_ROUND.currentHole = 0;
  if(!CURRENT_ROUND.viewMode) CURRENT_ROUND.viewMode = 'all';
  const activeHole = getActiveHole(CURRENT_ROUND);
  const totals = computeRoundTotals(CURRENT_ROUND);
  roundTitle.textContent = `${CURRENT_ROUND.course} • Hole ${activeHole ? activeHole.number : 1}`;
  const viewToggleText = (CURRENT_ROUND.viewMode === 'current') ? 'Show all holes' : 'Show current hole';
  roundMeta.innerHTML = `Date ${CURRENT_ROUND.date} • Holes ${CURRENT_ROUND.holes.length} • Total ${totals.totalStrokes} (Par ${totals.totalPar}) <div style="margin-top:6px"><button id="toggleViewBtn" class="btn" style="padding:8px;font-size:13px">${viewToggleText}</button></div>`;
  setTimeout(()=> {
    const tbtn = document.getElementById('toggleViewBtn');
    if(tbtn) tbtn.onclick = async ()=> { CURRENT_ROUND.viewMode = (CURRENT_ROUND.viewMode === 'current') ? 'all' : 'current'; await saveRound(CURRENT_ROUND); renderActiveRound(); };
  }, 0);
  quickFavorites.innerHTML = '';
  (CFG.favorites || []).forEach(f=>{
    const b = document.createElement('button');
    b.className = 'favBtn';
    b.textContent = f.label || `${f.club} • ${f.outcome}`;
    b.onclick = ()=> quickLogFromFavorite(f);
    quickFavorites.appendChild(b);
  });

  recentShots.innerHTML = '';

  // nav controls
  const navDiv = document.createElement('div'); navDiv.className = 'row gap';
  const prevBtn = document.createElement('button'); prevBtn.className='btn'; prevBtn.textContent='◀ Prev'; prevBtn.onclick = async ()=>{ setActiveHoleIndex(CURRENT_ROUND, (CURRENT_ROUND.currentHole||0)-1); await saveRound(CURRENT_ROUND); renderActiveRound(); };
  const nextBtn = document.createElement('button'); nextBtn.className='btn'; nextBtn.textContent='Next ▶'; nextBtn.onclick = async ()=>{ setActiveHoleIndex(CURRENT_ROUND, (CURRENT_ROUND.currentHole||0)+1); await saveRound(CURRENT_ROUND); renderActiveRound(); };
  const jumpInfo = document.createElement('div'); jumpInfo.className='muted small'; jumpInfo.style.marginLeft='8px'; jumpInfo.textContent = `Hole ${(CURRENT_ROUND.currentHole||0)+1} / ${CURRENT_ROUND.holes.length}`;
  navDiv.appendChild(prevBtn); navDiv.appendChild(nextBtn); navDiv.appendChild(jumpInfo);
  recentShots.appendChild(navDiv);

  // compact current-hole view
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
      <button class="btn" style="flex:1" onclick="openTeeShotFlow()">Tee Shot</button>
      <button class="btn" style="flex:1" onclick="advanceHoleAndSave()">Done & Next</button>
    </div>`;
    recentShots.appendChild(col);

    window.openDetailedShotFormByIdSimple = function(){ openDetailedShotForm(CURRENT_ROUND, h); };
    window.advanceHoleAndSave = async function(){
      const idx = CURRENT_ROUND.currentHole || 0;
      if(idx < (CURRENT_ROUND.holes.length - 1)) setActiveHoleIndex(CURRENT_ROUND, idx + 1);
      else alert('This is the last hole.');
      await saveRound(CURRENT_ROUND);
      renderActiveRound();
    };

  } else {
    // all-holes grid
    const holesDiv = document.createElement('div'); holesDiv.style.display='grid'; holesDiv.style.gridTemplateColumns='repeat(3,1fr)'; holesDiv.style.gap='8px';
    (CURRENT_ROUND.holes || []).forEach((h, idx)=>{
      const strokes = computeHoleStrokes(h);
      const res = holeResult(h);
      const col = document.createElement('div');
      col.className = 'shotItem';
      col.style.padding = '8px';
      if(idx === (CURRENT_ROUND.currentHole || 0)) col.style.border = '2px solid var(--primary)';
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
  const totals = computeRoundTotals(CURRENT_ROUND);
  const summary = document.createElement('div'); summary.className='card'; summary.style.marginTop='10px';
  summary.innerHTML = `<div class="row between">
    <div><strong>Round total</strong><div class="muted small">Holes: ${CURRENT_ROUND.holes.length}</div></div>
    <div style="text-align:right"><div style="font-weight:700;font-size:18px">${totals.totalStrokes}</div><div class="muted small">Par ${totals.totalPar} • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}</div></div>
  </div>`;
  recentShots.appendChild(summary);
}

// open detailed shot form by hole button
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

// quickLog from favorite
async function quickLogFromFavorite(fav){
  if(!CURRENT_ROUND) return alert('No active round. Start one first.');
  const hole = getActiveHole(CURRENT_ROUND);
  if(!hole) return alert('Active hole not found');
  const shot = {
    id: uid(), club: fav.club, lie: fav.lie || '', slope: fav.slope || '', strokeType: fav.stroke || fav.strokeType || 'Full',
    outcome: fav.outcome, notes: fav.notes||'', ts: new Date().toISOString()
  };
  hole.shots.push(shot);
  await saveRound(CURRENT_ROUND);
  renderActiveRound();
}

// --- Tee shot quick flow (no lie asked) ---
function openTeeShotFlow(){
  if(!CURRENT_ROUND) return alert('No active round.');
  const hole = getActiveHole(CURRENT_ROUND);
  if(!hole) return alert('Active hole not found.');
  overlay.innerHTML = ''; overlay.classList.remove('hidden');
  const form = document.createElement('div'); form.className='form';
  // club suggestions based on par
  const suggestedClubs = (hole.par >= 4) ? ['Driver','3-wood','5-wood','3-iron','4-iron'] : ['6-iron','7-iron','8-iron','9-iron','PW'];
  form.innerHTML = `<h3>Tee Shot — Hole ${hole.number} (Par ${hole.par})</h3>
    <div class="smallNote">Tee box: select club & outcome. Lie is automatically set to "Tee".</div>
    <div style="height:8px"></div>
    <div><label class="small">Suggested clubs</label><div id="teeClubGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Stroke</label><div id="teeStrokeGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Outcome</label><div id="teeOutGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <input id="teeNote" class="input" placeholder="Note (optional)" />
    <div class="row gap" style="margin-top:10px">
      <button id="saveTee" class="btn primary">Save Tee Shot</button>
      <button id="cancelTee" class="btn">Cancel</button>
    </div>`;
  overlay.appendChild(form);

  const cg = form.querySelector('#teeClubGrid');
  suggestedClubs.forEach(c=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=c; b.onclick=()=>select('club',c,b); cg.appendChild(b); });
  // includefull club list as fallback under suggestions
  const fullRow = document.createElement('div'); fullRow.style.marginTop='8px'; fullRow.innerHTML = `<div class="smallNote">More clubs</div><div id="teeClubFull" class="pickerGrid"></div>`;
  form.appendChild(fullRow);
  const cgFull = form.querySelector('#teeClubFull');
  CFG.clubs.forEach(c=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=c; b.onclick=()=>select('club',c,b); cgFull.appendChild(b); });

  const sg = form.querySelector('#teeStrokeGrid');
  CFG.strokes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>select('stroke',s,b); sg.appendChild(b); });

  const og = form.querySelector('#teeOutGrid');
  CFG.outcomes.forEach(o=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=o; b.onclick=()=>select('outcome',o,b); og.appendChild(b); });

  const selection = { club:null, stroke:null, outcome:null };
  function select(k,v,btn){
    selection[k] = v;
    let gid = '#teeClubGrid'; if(k==='stroke') gid = '#teeStrokeGrid'; else if(k==='outcome') gid = '#teeOutGrid';
    document.querySelectorAll(gid + ' .pickerBtn').forEach(x=>x.classList.remove('sel'));
    // also clear full grid selection if club chosen from full list
    if(k==='club') { document.querySelectorAll('#teeClubFull .pickerBtn').forEach(x=>x.classList.remove('sel')); }
    btn.classList.add('sel');
  }

  form.querySelector('#cancelTee').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#saveTee').onclick = async ()=>{
    if(!selection.club || !selection.stroke || !selection.outcome) return alert('Select club, stroke and outcome first.');
    const shot = { id: uid(), club: selection.club, strokeType: selection.stroke, lie: 'Tee', slope: '', outcome: selection.outcome, notes: form.querySelector('#teeNote').value||'', ts: new Date().toISOString() };
    hole.shots.push(shot);
    await saveRound(CURRENT_ROUND);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

// open quick log (full)
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
    <div><label class="small">Club</label><div id="clubGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Stroke</label><div id="strokeGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Outcome</label><div id="outGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Lie</label><div id="lieGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Slope</label><div id="slopeGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <input id="noteInput" class="input" placeholder="Short note (e.g. tight lie, wind left)" />
    <div class="row gap" style="margin-top:10px">
      <button id="saveShot" class="btn primary">Save</button>
      <button id="cancelShot" class="btn">Cancel</button>
    </div>`;
  overlay.appendChild(form);

  const cg = form.querySelector('#clubGrid');
  CFG.clubs.forEach(club=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=club; b.onclick=()=>selectPicker('club',club,b); cg.appendChild(b); });
  const sg = form.querySelector('#strokeGrid');
  CFG.strokes.forEach(st=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=st; b.onclick=()=>selectPicker('stroke',st,b); sg.appendChild(b); });
  const og = form.querySelector('#outGrid');
  CFG.outcomes.forEach(o=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=o; b.onclick=()=>selectPicker('outcome',o,b); og.appendChild(b); });
  const lg = form.querySelector('#lieGrid');
  CFG.lies.forEach(l=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=l; b.onclick=()=>selectPicker('lie',l,b); lg.appendChild(b); });
  const slg = form.querySelector('#slopeGrid');
  CFG.slopes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>selectPicker('slope',s,b); slg.appendChild(b); });

  const selection = { club:null, stroke:null, outcome:null, lie:null, slope:null };
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
    if(!selection.club || !selection.stroke || !selection.outcome) return alert('Select club, stroke and outcome first.');
    const hole = getActiveHole(round);
    if(!hole) return alert('Active hole not found.');
    const shot = { id: uid(), club: selection.club, strokeType: selection.stroke, lie: selection.lie || '', slope: selection.slope || '', outcome: selection.outcome, notes: form.querySelector('#noteInput').value||'', ts: new Date().toISOString() };
    hole.shots.push(shot);
    await saveRound(round);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

// detailed shot form (create/edit)
function openDetailedShotForm(round,hole, shotToEdit=null){
  overlay.innerHTML = ''; overlay.classList.remove('hidden');
  const form = document.createElement('div'); form.className='form';
  form.innerHTML = `<h3>${shotToEdit ? 'Edit Shot' : 'Shot'} — Hole ${hole.number}</h3>
    <label class="small">Club <div id="dclub" class="pickerGrid"></div></label>
    <label class="small">Stroke <div id="dstroke" class="pickerGrid"></div></label>
    <label class="small">Lie <div id="dlie" class="pickerGrid"></div></label>
    <label class="small">Slope <div id="dslope" class="pickerGrid"></div></label>
    <label class="small">Outcome <div id="dout" class="pickerGrid"></div></label>
    <input id="notes" class="input" placeholder="Notes (short)">
    <div class="row gap" style="margin-top:10px">
      <button id="save" class="btn primary">${shotToEdit ? 'Save' : 'Save'}</button>
      <button id="cancel" class="btn">Cancel</button>
      <button id="addPutt" class="btn">+Putt</button>
      <button id="deleteShot" class="btn danger" style="display:none">Delete</button>
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
  // if editing, pre-fill selections and show delete
  if(shotToEdit){
    form.querySelector('#notes').value = shotToEdit.notes || '';
    // helper to mark pickers after they are created
    setTimeout(()=> {
      if(shotToEdit.club) document.querySelectorAll('#dclub .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.club) x.classList.add('sel'), selection.club=shotToEdit.club; });
      if(shotToEdit.strokeType) document.querySelectorAll('#dstroke .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.strokeType) x.classList.add('sel'), selection.stroke=shotToEdit.strokeType; });
      if(shotToEdit.lie) document.querySelectorAll('#dlie .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.lie) x.classList.add('sel'), selection.lie=shotToEdit.lie; });
      if(shotToEdit.slope) document.querySelectorAll('#dslope .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.slope) x.classList.add('sel'), selection.slope=shotToEdit.slope; });
      if(shotToEdit.outcome) document.querySelectorAll('#dout .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.outcome) x.classList.add('sel'), selection.outcome=shotToEdit.outcome; });
    }, 0);
    form.querySelector('#deleteShot').style.display = 'inline-block';
  }

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
    if(!selection.club || !selection.stroke || !selection.outcome) return alert('Select club, stroke and outcome first.');
    const shot = { id: shotToEdit ? shotToEdit.id : uid(), club: selection.club, strokeType: selection.stroke, lie: selection.lie || '', slope: selection.slope || '', outcome: selection.outcome, notes: form.querySelector('#notes').value||'', ts: shotToEdit ? shotToEdit.ts : new Date().toISOString() };
    if(shotToEdit){
      // replace existing
      const idx = hole.shots.findIndex(s=>s.id===shotToEdit.id);
      if(idx>=0) hole.shots[idx] = shot;
    } else {
      hole.shots.push(shot);
    }
    await saveRound(CURRENT_ROUND);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
  form.querySelector('#deleteShot').onclick = async ()=>{
    if(!shotToEdit) return;
    if(!confirm('Delete this shot?')) return;
    const idx = hole.shots.findIndex(s=>s.id===shotToEdit.id);
    if(idx>=0) hole.shots.splice(idx,1);
    await saveRound(CURRENT_ROUND);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

// helper to open edit form for a specific shot
function openEditForShot(hole, shot){
  openDetailedShotForm(CURRENT_ROUND, hole, shot);
}

// modified renderActiveRound must show edit button next to each recent shot
// (we already call renderActiveRound widely; update recentShots listing to include edit)
//
// To support that, we will intercept where shots are shown: show edit per-shot where relevant.
// (The rest of the file above already uses renderActiveRound which will render shot lists in current/hole views.)
// For holes list we will attach edit buttons by editing the parts below when rendering shots in build.

// NOTE: previous functions that showed recent shots used only counts; now we will add per-shot display with Edit buttons
// We'll re-render the current active hole's shot list within renderActiveRound: if active hole exists, show last 8 shots with edit.


// Override renderActiveRound's recent-shot section enhancement by re-creating logic to add per-shot Edit buttons
// To avoid repeating large code, we will add a small helper that, when called after renderActiveRound constructed the hole card,
// finds the active hole and appends a detailed shots list with edit buttons.

async function appendPerShotEditList(){
  if(!CURRENT_ROUND) return;
  const activeHole = getActiveHole(CURRENT_ROUND);
  if(!activeHole) return;
  // find recentShots container (we used it as the main container)
  // remove any existing per-shot list
  const existing = document.getElementById('perShotList');
  if(existing) existing.remove();
  // find where to insert: after the main hole card (first .shotItem in recentShots)
  const container = recentShots;
  const list = document.createElement('div');
  list.id = 'perShotList';
  list.style.marginTop = '8px';
  list.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recent shots</div>`;
  const shots = (activeHole.shots||[]).slice(-12).reverse();
  shots.forEach(s=>{
    const row = document.createElement('div');
    row.className = 'shotItem';
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    row.style.padding = '10px';
    row.innerHTML = `<div><div><strong>${s.club}</strong> • ${s.strokeType} • ${s.outcome}</div><div class="muted small">${s.lie||''} ${s.slope? '• '+s.slope : ''} ${s.notes? ' • '+s.notes : ''}</div></div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn" style="padding:8px;font-size:13px">Edit</button>
      </div>`;
    // attach edit handler
    row.querySelector('button').onclick = ()=> openEditForShot(activeHole, s);
    list.appendChild(row);
  });
  container.appendChild(list);
}

// Wrap original renderActiveRound so we call appendPerShotEditList after it finishes building UI
// We will patch by replacing renderActiveRound variable with a wrapper that calls original then appends per-shot list.
// But since renderActiveRound is defined above, we'll simply call appendPerShotEditList at the end of renderActiveRound by injecting a small timer.
// To ensure it's executed, we add a global hook to call it after DOM updates.

const originalRenderActiveRound = renderActiveRound;
renderActiveRound = function(){
  originalRenderActiveRound();
  // attach edit lists for the active hole after a short tick
  setTimeout(()=> appendPerShotEditList(), 60);
};

// init
(async function init(){
  // set default date field to today
  const d = new Date().toISOString().slice(0,10);
  document.getElementById('roundDate').value = d;

  document.getElementById('menuBtn').onclick = ()=> openSettings();

  if('serviceWorker' in navigator){
    try{ await navigator.serviceWorker.register('/sw.js'); console.log('sw registered'); }catch(e){ console.warn('sw register failed',e); }
  }

  injectLocalCourseButton();
  await renderRoundsList();
  renderActiveRound();
})();
