/* GolfTrack PWA - app.js
   Updated: first-shot-as-tee, minimal tee prompts, backfill previous/next, quick action buttons,
   Add Shot opens popup (no separate Log pop-up button), edit/delete/copy-to-next.
*/

const DB_NAME = 'golftrack-db-v1';
const STORE = 'rounds';

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8) }

// IndexedDB helpers
function openDB(){ return new Promise((res,rej)=>{ const req = indexedDB.open(DB_NAME,1); req.onupgradeneeded=(e)=>{const db=e.target.result; if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:'id'});}; req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); });}
async function saveRound(r){ const db = await openDB(); return new Promise((res,rej)=>{ const tx = db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(r); tx.oncomplete = ()=> res(); tx.onerror = ()=> rej(tx.error); });}
async function loadAllRounds(){ const db = await openDB(); return new Promise((res,rej)=>{ const tx = db.transaction(STORE,'readonly').objectStore(STORE).getAll(); tx.onsuccess = ()=> res(tx.result || []); tx.onerror = ()=> rej(tx.error); });}
async function deleteRound(id){ const db = await openDB(); return new Promise((res,rej)=>{ const tx = db.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete = ()=> res(); tx.onerror = ()=> rej(tx.error); });}

// Config defaults
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

function getConfig(){ try{ const raw = localStorage.getItem('golftrack-config'); if(raw) return JSON.parse(raw); }catch(e){} localStorage.setItem('golftrack-config', JSON.stringify(DEFAULTS)); return DEFAULTS; }
function saveConfig(cfg){ localStorage.setItem('golftrack-config', JSON.stringify(cfg)); }

const CFG = getConfig();

// DOM refs
const $ = id => document.getElementById(id);
const overlay = $('overlay');
const activeRoundSection = $('activeRound');
const roundTitle = $('roundTitle');
const roundMeta = $('roundMeta');
const recentShots = $('recentShots');
const quickFavorites = $('quickFavorites');

let CURRENT_ROUND = null;

// Local course
const LOCAL_COURSE = { name: 'Local Course', pars: [4,3,4,3,5,4,5,4,4, 4,4,5,3,4,5,4,3,4] };

// Helpers
function timeShort(iso){ return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function getActiveHole(round){ if(!round) return null; if(!Array.isArray(round.holes)||round.holes.length===0) return null; const idx = typeof round.currentHole === 'number' ? round.currentHole : 0; const safeIdx = Math.max(0, Math.min(round.holes.length-1, idx)); if(round.currentHole !== safeIdx) round.currentHole = safeIdx; return round.holes[safeIdx]; }
function setActiveHoleIndex(round, idx){ if(!round) return; round.currentHole = Math.max(0, Math.min((round.holes||[]).length-1, idx)); }

function computeHoleStrokes(hole){ const shots = hole.shots||[]; const totalShotEntries = shots.length; const puttShots = shots.filter(s => (s.strokeType||'').toLowerCase() === 'putt').length; const extraPutts = hole.putts || 0; const strokes = totalShotEntries + extraPutts - puttShots; return Math.max(strokes, totalShotEntries); }
function holeResult(hole){ const strokes = computeHoleStrokes(hole); const par = hole.par || 0; if(par===0) return `${strokes}`; const diff = strokes - par; if(diff===0) return 'E'; if(diff===-1) return '-1'; if(diff===1) return '+1'; if(diff < -1) return `${diff}`; return `+${diff}`; }
function computeRoundTotals(round){ const holes = round.holes||[]; let totalPar=0,totalStrokes=0; holes.forEach(h=>{ totalPar+=(h.par||0); totalStrokes+=computeHoleStrokes(h); }); return { totalPar, totalStrokes, diff: totalStrokes-totalPar }; }

// UI injection
function injectLocalCourseButton(){ try{ const createCard = document.querySelector('.create-round .row.gap') || document.querySelector('.create-round .row'); if(!createCard) return; if(document.getElementById('useLocalCourseBtn')) return; const btn = document.createElement('button'); btn.id='useLocalCourseBtn'; btn.className='btn'; btn.textContent='Use Local Course'; btn.style.minWidth='140px'; btn.onclick = ()=> createLocalCourseRound(); createCard.appendChild(btn);}catch(e){} }
async function createLocalCourseRound(){ const r = { id: uid(), date: new Date().toISOString().slice(0,10), course: LOCAL_COURSE.name, holes: [], notes:'', createdAt:new Date().toISOString(), currentHole:0, viewMode:'current' }; for(let i=0;i<LOCAL_COURSE.pars.length;i++) r.holes.push({ id: uid(), number: i+1, par: LOCAL_COURSE.pars[i], shots: [], putts:0 }); await saveRound(r); CURRENT_ROUND = r; renderActiveRound(); renderRoundsList(); }

// Create manual round
$('createRound').addEventListener('click', async ()=>{ const course = $('course').value.trim() || 'Unknown'; const date = $('roundDate').value || new Date().toISOString().slice(0,10); const r = { id: uid(), date, course, holes: [], notes:'', createdAt:new Date().toISOString(), currentHole:0, viewMode:'all' }; r.holes.push({ id: uid(), number:1, par:4, shots:[], putts:0 }); await saveRound(r); CURRENT_ROUND = r; renderActiveRound(); renderRoundsList(); });

// Listeners (Add Shot behavior)
$('navSettings').addEventListener('click', ()=> openSettings());
$('endRoundBtn').addEventListener('click', async ()=>{ if(!CURRENT_ROUND) return; if(!confirm('End round and save?')) return; CURRENT_ROUND = null; renderActiveRound(); renderRoundsList();});
$('addHoleBtn').addEventListener('click', async ()=>{ if(!CURRENT_ROUND) return; if((CURRENT_ROUND.holes||[]).length >= 18) return alert('Maximum 18 holes reached.'); const holeNumber=(CURRENT_ROUND.holes.length||0)+1; CURRENT_ROUND.holes.push({id:uid(),number:holeNumber,par:4,shots:[],putts:0}); setActiveHoleIndex(CURRENT_ROUND, CURRENT_ROUND.holes.length-1); CURRENT_ROUND.viewMode='current'; await saveRound(CURRENT_ROUND); renderActiveRound(); });

// Export CSV unchanged (kept)
$('exportBtn').addEventListener('click', async ()=>{ const rounds = await loadAllRounds(); if(!rounds.length){ alert('No rounds to export'); return; } const rows=[['round_id','date','course','hole','par','shot_id','club','stroke','lie','slope','outcome','notes','timestamp','strokes','putts']]; rounds.forEach(r=>{ r.holes.forEach(h=>{ const strokes=computeHoleStrokes(h); if(h.shots && h.shots.length){ h.shots.forEach(s=>{ rows.push([r.id,r.date,r.course,h.number,h.par||'',s.id,s.club,s.strokeType,s.lie||'',s.slope||'',s.outcome,(s.notes||''),s.ts,strokes,h.putts||0]); }); } else rows.push([r.id,r.date,r.course,h.number,h.par||'','','','','','','','', '', strokes, h.putts||0]); });}); const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'); const blob = new Blob([csv],{type:'text/csv'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`golftrack_export_${new Date().toISOString().slice(0,10)}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); });

// Render rounds list
async function renderRoundsList(){ const rounds = (await loadAllRounds()).sort((a,b)=>b.date.localeCompare(a.date)); const existing = document.querySelector('#roundsListRoot'); if(existing) existing.remove(); const listRoot=document.createElement('div'); listRoot.style.maxWidth='720px'; listRoot.style.margin='0 auto'; listRoot.id='roundsListRoot'; rounds.forEach(r=>{ const totals=computeRoundTotals(r); const el=document.createElement('div'); el.className='card'; el.style.marginBottom='10px'; el.innerHTML = `<div class="row between"><div><div style="font-weight:700">${r.course} <span class="muted small">(${r.date})</span></div><div class="muted small">${(r.holes||[]).length} hole(s) • ${new Date(r.createdAt).toLocaleString()}</div><div class="muted small">Score: ${totals.totalStrokes} (Par ${totals.totalPar}) • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}</div></div><div style="display:flex;flex-direction:column;gap:8px"><button class="btn" data-id="${r.id}" data-action="open">Open</button><button class="btn" data-id="${r.id}" data-action="delete">Delete</button></div></div>`; listRoot.appendChild(el); }); const createCard = document.querySelector('.create-round'); createCard.insertAdjacentElement('afterend', listRoot); listRoot.querySelectorAll('button[data-action="open"]').forEach(b=>{ b.onclick = async ev => { const id = ev.target.getAttribute('data-id'); const rounds = await loadAllRounds(); const r = rounds.find(rr=>rr.id===id); CURRENT_ROUND = r; renderActiveRound(); }; }); listRoot.querySelectorAll('button[data-action="delete"]').forEach(b=>{ b.onclick = async ev => { const id = ev.target.getAttribute('data-id'); if(!confirm('Delete this round?')) return; await deleteRound(id); if(CURRENT_ROUND && CURRENT_ROUND.id===id) CURRENT_ROUND=null; renderActiveRound(); renderRoundsList(); }; }); if(!CURRENT_ROUND && rounds.length){ CURRENT_ROUND = rounds[0]; renderActiveRound(); }}

// Add Shot quick flow: if first shot in hole -> tee-shot simplified, else normal quick popup
function openQuickLogOrTee(round){
  const hole = getActiveHole(round);
  if(!hole) return alert('No active hole.');
  // If first shot of hole, open tee-shot minimal flow
  if((hole.shots||[]).length === 0){
    openTeeShotFlow();
  } else {
    openQuickLog(round);
  }
}

// Quick-action mapping (quick buttons)
const QUICK_ACTIONS = {
  Push: { outcome: 'Push', strokeType: 'Full' },
  Slice: { outcome: 'Slice', strokeType: 'Full' },
  Pull: { outcome: 'Pull', strokeType: 'Full' },
  Hook: { outcome: 'Hook', strokeType: 'Full' },
  'Perfect': { outcome: 'Good', strokeType: 'Full' }
};

// Tee-shot flow (minimal)
function openTeeShotFlow(){
  if(!CURRENT_ROUND) return alert('No active round.');
  const hole = getActiveHole(CURRENT_ROUND);
  if(!hole) return alert('No active hole.');
  overlay.innerHTML=''; overlay.classList.remove('hidden');
  const form = document.createElement('div'); form.className='form';

  // Determine suggested clubs
  const suggested = hole.par >= 4 ? ['Driver','3-wood','5-wood','3-iron','4-iron'] : ['6-iron','7-iron','8-iron','9-iron','PW'];

  form.innerHTML = `<h3>Tee Shot — Hole ${hole.number} (Par ${hole.par})</h3>
    <div class="smallNote">Tee box: select club & outcome. Lie will be set to "Tee".</div>
    <div style="height:8px"></div>
    <div><label class="small">Suggested clubs</label><div id="teeClubGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Outcome (or quick)</label><div id="teeQuickActions" style="display:flex;gap:8px;margin-bottom:8px"></div><div id="teeOutGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div id="teeHitQuestion" style="margin-top:8px"></div>
    <div style="height:8px"></div>
    <input id="teeNote" class="input" placeholder="Note (optional)" />
    <div class="row gap" style="margin-top:10px">
      <button id="saveTee" class="btn primary">Save Tee Shot</button>
      <button id="cancelTee" class="btn">Cancel</button>
    </div>`;

  overlay.appendChild(form);

  // render suggested & full clubs
  const cg = form.querySelector('#teeClubGrid');
  suggested.forEach(c=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=c; b.onclick=()=>select('club',c,b); cg.appendChild(b); });
  const fullRow = document.createElement('div'); fullRow.style.marginTop='8px'; fullRow.innerHTML = `<div class="smallNote">More clubs</div><div id="teeClubFull" class="pickerGrid"></div>`; form.appendChild(fullRow);
  const cgFull = form.querySelector('#teeClubFull');
  CFG.clubs.forEach(c=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=c; b.onclick=()=>select('club',c,b); cgFull.appendChild(b); });

  // quick action buttons
  const qa = form.querySelector('#teeQuickActions');
  ['Push','Slice','Pull','Hook','Perfect'].forEach(k=>{ const b=document.createElement('button'); b.className='btn'; b.textContent=k; b.onclick=()=> quickActionSave(k); qa.appendChild(b); });

  const og = form.querySelector('#teeOutGrid');
  CFG.outcomes.forEach(o=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=o; b.onclick=()=>select('outcome',o,b); og.appendChild(b); });

  // show only the required hit question
  const qWrap = form.querySelector('#teeHitQuestion');
  if(hole.par >= 4){
    qWrap.innerHTML = `<div class="small">Did you hit the fairway?</div><div style="display:flex;gap:8px;margin-top:6px"><button id="hitYes" class="btn">Yes</button><button id="hitNo" class="btn">No</button></div><div id="missSide" style="margin-top:8px"></div>`;
    qWrap.querySelector('#hitYes').onclick = ()=> { selection.fairway = true; qWrap.querySelector('#missSide').innerHTML=''; };
    qWrap.querySelector('#hitNo').onclick = ()=> { selection.fairway = false; qWrap.querySelector('#missSide').innerHTML = `<div class="small">Missed side?</div><div style="display:flex;gap:8px;margin-top:6px"><button id="missL" class="btn">Left</button><button id="missR" class="btn">Right</button></div>`; qWrap.querySelector('#missL').onclick = ()=> selection.missSide='Left'; qWrap.querySelector('#missR').onclick = ()=> selection.missSide='Right'; };
  } else {
    qWrap.innerHTML = `<div class="small">Did you hit the green?</div><div style="display:flex;gap:8px;margin-top:6px"><button id="hitGreenYes" class="btn">Yes</button><button id="hitGreenNo" class="btn">No</button></div><div id="missSide3" style="margin-top:8px"></div>`;
    qWrap.querySelector('#hitGreenYes').onclick = ()=> { selection.green = true; qWrap.querySelector('#missSide3').innerHTML=''; };
    qWrap.querySelector('#hitGreenNo').onclick = ()=> { selection.green = false; qWrap.querySelector('#missSide3').innerHTML = `<div class="small">Missed side?</div><div style="display:flex;gap:8px;margin-top:6px"><button id="missL3" class="btn">Left</button><button id="missR3" class="btn">Right</button></div>`; qWrap.querySelector('#missL3').onclick = ()=> selection.missSide='Left'; qWrap.querySelector('#missR3').onclick = ()=> selection.missSide='Right'; };
  }

  const selection = { club:null, stroke:'Full', outcome:null, fairway:null, green:null, missSide:null };

  function select(k,v,btn){
    selection[k] = v;
    let gid = '#teeClubGrid'; if(k==='outcome') gid='#teeOutGrid';
    document.querySelectorAll(gid + ' .pickerBtn').forEach(x=>x.classList.remove('sel'));
    // clear full-grid club selectors too
    if(k==='club'){ document.querySelectorAll('#teeClubFull .pickerBtn').forEach(x=>x.classList.remove('sel')); }
    btn.classList.add('sel');
  }

  // quick-action immediate save
  async function quickActionSave(key){
    const action = QUICK_ACTIONS[key];
    if(!action) return;
    // ensure a club is selected (prefer first suggested if not)
    if(!selection.club){ selection.club = suggested[0] || CFG.clubs[0]; }
    const shot = { id: uid(), club: selection.club, strokeType: action.strokeType || 'Full', lie: 'Tee', slope:'', outcome: action.outcome || 'Other', notes: form.querySelector('#teeNote').value||'', ts: new Date().toISOString() };
    hole.shots.push(shot);
    // mark fairway/green info into shot.notes for quick reference
    if(selection.fairway === true) shot.notes = (shot.notes?shot.notes+' • ':'') + 'Hit fairway';
    if(selection.fairway === false && selection.missSide) shot.notes = (shot.notes?shot.notes+' • ':'') + `Miss ${selection.missSide}`;
    if(selection.green === true) shot.notes = (shot.notes?shot.notes+' • ':'') + 'Hit green';
    if(selection.green === false && selection.missSide) shot.notes = (shot.notes?shot.notes+' • ':'') + `Miss ${selection.missSide}`;
    await saveRound(CURRENT_ROUND);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
    // if landed on green, offer to backfill previous shot
    if(shot.lie === 'Green' || (selection.green === true)) { tryBackfillPreviousGreen(hole); }
  }

  form.querySelector('#cancelTee').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#saveTee').onclick = async ()=>{
    if(!selection.club) return alert('Select a club.');
    if(!selection.outcome) selection.outcome = 'Other';
    const shot = { id: uid(), club: selection.club, strokeType: selection.stroke || 'Full', lie:'Tee', slope:'', outcome: selection.outcome, notes: form.querySelector('#teeNote').value||'', ts: new Date().toISOString() };
    if(selection.fairway === true) shot.notes = (shot.notes?shot.notes+' • ':'') + 'Hit fairway';
    if(selection.fairway === false && selection.missSide) shot.notes = (shot.notes?shot.notes+' • ':'') + `Miss ${selection.missSide}`;
    if(selection.green === true) shot.notes = (shot.notes?shot.notes+' • ':'') + 'Hit green';
    if(selection.green === false && selection.missSide) shot.notes = (shot.notes?shot.notes+' • ':'') + `Miss ${selection.missSide}`;
    hole.shots.push(shot);
    await saveRound(CURRENT_ROUND);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
    if(selection.green === true) tryBackfillPreviousGreen(hole);
  };
}

// Normal quick log (non-tee)
function openQuickLog(round){
  if(!round) return alert('No active round.');
  const hole = getActiveHole(round);
  if(!hole) return alert('No active hole.');
  overlay.innerHTML=''; overlay.classList.remove('hidden');
  const form = document.createElement('div'); form.className='form';
  form.innerHTML = `<h3>Quick Log — Hole ${hole.number}</h3>
    <div class="smallNote">Tap club → stroke → outcome → lie → slope → Save. Or use quick actions below.</div>
    <div style="height:8px"></div>
    <div><label class="small">Club</label><div id="clubGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Stroke</label><div id="strokeGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Outcome (or quick)</label><div id="quickActionsRow" style="display:flex;gap:8px;margin-bottom:8px"></div><div id="outGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Lie</label><div id="lieGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <div><label class="small">Slope</label><div id="slopeGrid" class="pickerGrid"></div></div>
    <div style="height:8px"></div>
    <input id="noteInput" class="input" placeholder="Short note (optional)" />
    <div class="row gap" style="margin-top:10px">
      <button id="saveShot" class="btn primary">Save</button>
      <button id="cancelShot" class="btn">Cancel</button>
    </div>`;
  overlay.appendChild(form);

  const cg = form.querySelector('#clubGrid');
  CFG.clubs.forEach(club=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=club; b.onclick=()=>select('club',club,b); cg.appendChild(b); });

  const sg = form.querySelector('#strokeGrid');
  CFG.strokes.forEach(st=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=st; b.onclick=()=>select('stroke',st,b); sg.appendChild(b); });

  const oq = form.querySelector('#quickActionsRow');
  ['Push','Slice','Pull','Hook','Perfect'].forEach(k=>{ const b=document.createElement('button'); b.className='btn'; b.textContent=k; b.onclick=()=> quickAction(k); oq.appendChild(b); });

  const og = form.querySelector('#outGrid');
  CFG.outcomes.forEach(o=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=o; b.onclick=()=>select('outcome',o,b); og.appendChild(b); });

  const lg = form.querySelector('#lieGrid');
  CFG.lies.forEach(l=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=l; b.onclick=()=>select('lie',l,b); lg.appendChild(b); });

  const slg = form.querySelector('#slopeGrid');
  CFG.slopes.forEach(s=>{ const b=document.createElement('button'); b.className='pickerBtn'; b.textContent=s; b.onclick=()=>select('slope',s,b); slg.appendChild(b); });

  const selection = { club:null, stroke:null, outcome:null, lie:null, slope:null };

  function select(type, value, btn){
    selection[type] = value;
    let gridId = '#clubGrid';
    if(type==='stroke') gridId='#strokeGrid';
    else if(type==='outcome') gridId='#outGrid';
    else if(type==='lie') gridId='#lieGrid';
    else if(type==='slope') gridId='#slopeGrid';
    document.querySelectorAll(gridId + ' .pickerBtn').forEach(x=>x.classList.remove('sel'));
    btn.classList.add('sel');
  }

  async function quickAction(key){
    const a = QUICK_ACTIONS[key];
    if(!a) return;
    if(!selection.club) selection.club = CFG.clubs[0];
    const shot = { id: uid(), club: selection.club, strokeType: a.strokeType || 'Full', lie: selection.lie || '', slope: selection.slope || '', outcome: a.outcome || 'Other', notes: form.querySelector('#noteInput').value||'', ts: new Date().toISOString() };
    hole.shots.push(shot);
    await saveRound(CURRENT_ROUND);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
    if(shot.lie === 'Green') tryBackfillPreviousGreen(hole);
  }

  form.querySelector('#cancelShot').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#saveShot').onclick = async ()=>{
    if(!selection.club || !selection.stroke || !selection.outcome) return alert('Select club, stroke and outcome.');
    const shot = { id: uid(), club: selection.club, strokeType: selection.stroke, lie: selection.lie||'', slope: selection.slope||'', outcome: selection.outcome, notes: form.querySelector('#noteInput').value||'', ts: new Date().toISOString() };
    hole.shots.push(shot);
    await saveRound(CURRENT_ROUND);
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
    if(shot.lie === 'Green') tryBackfillPreviousGreen(hole);
  };
}

// Try backfilling previous shot if new shot is on green (prompt user)
async function tryBackfillPreviousGreen(hole){
  if(!CURRENT_ROUND) return;
  const hIdx = CURRENT_ROUND.holes.findIndex(h=>h.id === hole.id);
  if(hIdx < 0) return;
  const shots = hole.shots || [];
  if(!shots.length) return;
  const lastShot = shots[shots.length-1];
  // if lastShot indicates green (either lie 'Green' or notes include 'Hit green')
  const landedGreen = (lastShot.lie === 'Green') || (lastShot.notes && lastShot.notes.toLowerCase().includes('hit green'));
  if(!landedGreen) return;
  // find previous shot: either earlier shot in same hole or last shot of previous hole
  let prevShot = null;
  if(shots.length >= 2) prevShot = shots[shots.length-2];
  else {
    // try previous hole last shot
    if(hIdx > 0){
      const prevHole = CURRENT_ROUND.holes[hIdx-1];
      const ps = prevHole.shots || [];
      if(ps.length) prevShot = ps[ps.length-1];
    }
  }
  if(!prevShot) return;
  // ask user to apply lie='Green' to previous shot (backfill)
  if(confirm('This shot landed on the green. Apply "Green" lie to the previous shot for easier review?')){
    prevShot.lie = 'Green';
    // optionally tag notes
    prevShot.notes = (prevShot.notes? prevShot.notes + ' • ':'') + 'Landed on green';
    await saveRound(CURRENT_ROUND);
    renderActiveRound();
  }
}

// Detailed shot form (create/edit)
function openDetailedShotForm(round,hole, shotToEdit=null){
  overlay.innerHTML=''; overlay.classList.remove('hidden');
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
      <button id="copyToNext" class="btn">Copy to next</button>
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

  if(shotToEdit){
    form.querySelector('#notes').value = shotToEdit.notes || '';
    setTimeout(()=> {
      if(shotToEdit.club) document.querySelectorAll('#dclub .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.club){ x.classList.add('sel'); selection.club=shotToEdit.club; }});
      if(shotToEdit.strokeType) document.querySelectorAll('#dstroke .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.strokeType){ x.classList.add('sel'); selection.stroke=shotToEdit.strokeType; }});
      if(shotToEdit.lie) document.querySelectorAll('#dlie .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.lie){ x.classList.add('sel'); selection.lie=shotToEdit.lie; }});
      if(shotToEdit.slope) document.querySelectorAll('#dslope .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.slope){ x.classList.add('sel'); selection.slope=shotToEdit.slope; }});
      if(shotToEdit.outcome) document.querySelectorAll('#dout .pickerBtn').forEach(x=>{ if(x.textContent===shotToEdit.outcome){ x.classList.add('sel'); selection.outcome=shotToEdit.outcome; }});
    }, 0);
    form.querySelector('#deleteShot').style.display='inline-block';
  }

  function select(k,v,btn){ selection[k]=v; const gridId = btn.parentElement.id; document.querySelectorAll('#'+gridId+' .pickerBtn').forEach(x=>x.classList.remove('sel')); btn.classList.add('sel'); }

  form.querySelector('#cancel').onclick = ()=> { overlay.classList.add('hidden'); overlay.innerHTML=''; };
  form.querySelector('#addPutt').onclick = async ()=>{ hole.putts = (hole.putts||0)+1; await saveRound(CURRENT_ROUND); overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound(); };
  form.querySelector('#save').onclick = async ()=>{ if(!selection.club || !selection.stroke || !selection.outcome) return alert('Select club, stroke and outcome first.'); const shot = { id: shotToEdit ? shotToEdit.id : uid(), club: selection.club, strokeType: selection.stroke, lie: selection.lie||'', slope: selection.slope||'', outcome: selection.outcome, notes: form.querySelector('#notes').value||'', ts: shotToEdit ? shotToEdit.ts : new Date().toISOString() }; if(shotToEdit){ const idx = hole.shots.findIndex(s=>s.id===shotToEdit.id); if(idx>=0) hole.shots[idx] = shot; } else hole.shots.push(shot); await saveRound(CURRENT_ROUND); overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound(); if(shot.lie === 'Green') tryBackfillPreviousGreen(hole); };
  form.querySelector('#deleteShot').onclick = async ()=>{ if(!shotToEdit) return; if(!confirm('Delete this shot?')) return; const idx = hole.shots.findIndex(s=>s.id===shotToEdit.id); if(idx>=0) hole.shots.splice(idx,1); await saveRound(CURRENT_ROUND); overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound(); };
  // copy to next helper: if next shot exists, copy club/outcome/lie/slope
  form.querySelector('#copyToNext').onclick = async ()=>{ if(!shotToEdit) return alert('Save shot first to copy to next.'); // find next shot if exists (same hole index)
    const holeIndex = CURRENT_ROUND.holes.findIndex(h=>h.id===hole.id);
    if(holeIndex < 0) return;
    const shotIndex = hole.shots.findIndex(s=>s.id===shotToEdit.id);
    // try next shot in same hole
    let nextShot = null;
    if(shotIndex >= 0 && shotIndex < hole.shots.length - 1) nextShot = hole.shots[shotIndex+1];
    else {
      // try first shot of next hole
      if(holeIndex < CURRENT_ROUND.holes.length-1){
        const nextHole = CURRENT_ROUND.holes[holeIndex+1];
        if(nextHole.shots && nextHole.shots.length) nextShot = nextHole.shots[0];
      }
    }
    if(!nextShot) return alert('No next shot found to copy into.');
    // copy fields from shotToEdit into nextShot
    nextShot.club = shotToEdit.club; nextShot.strokeType = shotToEdit.strokeType; nextShot.lie = shotToEdit.lie; nextShot.slope = shotToEdit.slope; nextShot.outcome = shotToEdit.outcome;
    await saveRound(CURRENT_ROUND);
    alert('Copied to next shot.');
    overlay.classList.add('hidden'); overlay.innerHTML=''; renderActiveRound();
  };
}

// helper to open edit for shot (used by per-shot UI)
function openEditForShot(hole, shot){ openDetailedShotForm(CURRENT_ROUND, hole, shot); }

// Append per-shot edit list under current hole (used by renderActiveRound)
async function appendPerShotEditList(){
  if(!CURRENT_ROUND) return;
  const activeHole = getActiveHole(CURRENT_ROUND);
  if(!activeHole) return;
  const existing = document.getElementById('perShotList'); if(existing) existing.remove();
  const container = recentShots;
  const list = document.createElement('div'); list.id='perShotList'; list.style.marginTop='8px'; list.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recent shots</div>`;
  const shots = (activeHole.shots||[]).slice(-12).reverse();
  shots.forEach(s=>{
    const row = document.createElement('div');
    row.className = 'shotItem';
    row.style.display = 'flex'; row.style.justifyContent='space-between'; row.style.alignItems='center'; row.style.padding='10px';
    row.innerHTML = `<div><div><strong>${s.club}</strong> • ${s.strokeType} • ${s.outcome}</div><div class="muted small">${s.lie? s.lie + ' • ' : ''}${s.slope? s.slope + ' • ' : ''}${s.notes? s.notes : ''}</div></div>
      <div style="display:flex;flex-direction:column;gap:6px"><button class="btn" style="padding:8px;font-size:13px">Edit</button></div>`;
    row.querySelector('button').onclick = ()=> openEditForShot(activeHole, s);
    list.appendChild(row);
  });
  container.appendChild(list);
}

// renderActiveRound (main UI) — Add Shot buttons now open quick popup; per-hole Add uses openQuickLogOrTee
function renderActiveRound(){
  if(!CURRENT_ROUND){ activeRoundSection.classList.add('hidden'); return; }
  activeRoundSection.classList.remove('hidden');
  if(typeof CURRENT_ROUND.currentHole !== 'number') CURRENT_ROUND.currentHole = 0;
  if(!CURRENT_ROUND.viewMode) CURRENT_ROUND.viewMode = 'all';
  const activeHole = getActiveHole(CURRENT_ROUND);
  const totals = computeRoundTotals(CURRENT_ROUND);
  roundTitle.textContent = `${CURRENT_ROUND.course} • Hole ${activeHole ? activeHole.number : 1}`;
  const viewToggleText = (CURRENT_ROUND.viewMode === 'current') ? 'Show all holes' : 'Show current hole';
  roundMeta.innerHTML = `Date ${CURRENT_ROUND.date} • Holes ${CURRENT_ROUND.holes.length} • Total ${totals.totalStrokes} (Par ${totals.totalPar}) <div style="margin-top:6px"><button id="toggleViewBtn" class="btn" style="padding:8px;font-size:13px">${viewToggleText}</button></div>`;
  setTimeout(()=>{ const tbtn = document.getElementById('toggleViewBtn'); if(tbtn) tbtn.onclick = async ()=> { CURRENT_ROUND.viewMode = (CURRENT_ROUND.viewMode === 'current') ? 'all' : 'current'; await saveRound(CURRENT_ROUND); renderActiveRound(); }; }, 0);

  // favorites (unchanged)
  quickFavorites.innerHTML = '';
  (CFG.favorites || []).forEach(f=>{ const b = document.createElement('button'); b.className = 'favBtn'; b.textContent = f.label || `${f.club} • ${f.outcome}`; b.onclick = ()=> { // quick favorite saves to active hole
    const hole = getActiveHole(CURRENT_ROUND); if(!hole) return; const shot = { id: uid(), club: f.club, strokeType: f.stroke || 'Full', lie: f.lie || '', slope: f.slope || '', outcome: f.outcome, notes: f.notes||'', ts: new Date().toISOString() }; hole.shots.push(shot); saveRound(CURRENT_ROUND).then(()=>renderActiveRound()); }; quickFavorites.appendChild(b); });

  // recentShots area
  recentShots.innerHTML = '';

  // nav controls
  const navDiv = document.createElement('div'); navDiv.className='row gap';
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
    const col = document.createElement('div'); col.className='shotItem'; col.style.padding='12px';
    col.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><div><strong>Hole ${h.number}</strong><div class="muted small">Par ${h.par||'-'}</div></div><div style="text-align:right"><div style="font-weight:700;font-size:20px">${strokes}</div><div class="muted small">${res}</div></div></div><div class="muted small" style="margin-top:8px">${(h.shots||[]).length} shots • Putts: ${h.putts||0}</div><div style="margin-top:12px" class="row gap"><button class="btn" style="flex:1" onclick="openQuickLogOrTee(CURRENT_ROUND)">Add Shot</button><button class="btn" style="flex:1" onclick="advanceHoleAndSave()">Done & Next</button></div>`;
    recentShots.appendChild(col);
    window.advanceHoleAndSave = async function(){ const idx = CURRENT_ROUND.currentHole || 0; if(idx < (CURRENT_ROUND.holes.length - 1)) setActiveHoleIndex(CURRENT_ROUND, idx + 1); else alert('This is the last hole.'); await saveRound(CURRENT_ROUND); renderActiveRound(); };
  } else {
    // show full holes grid
    const holesDiv = document.createElement('div'); holesDiv.style.display='grid'; holesDiv.style.gridTemplateColumns='repeat(3,1fr)'; holesDiv.style.gap='8px';
    (CURRENT_ROUND.holes||[]).forEach((h, idx)=>{ const strokes = computeHoleStrokes(h); const res = holeResult(h); const col = document.createElement('div'); col.className='shotItem'; col.style.padding='8px'; if(idx === (CURRENT_ROUND.currentHole||0)) col.style.border='2px solid var(--primary)'; col.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><div><strong>Hole ${h.number}</strong> <div class="muted small">Par ${h.par||'-'}</div></div><div style="text-align:right"><div style="font-weight:700">${strokes}</div><div class="muted small">${res}</div></div></div><div class="muted small" style="margin-top:6px">${(h.shots||[]).length} shots • Putts: ${h.putts||0}</div><div style="margin-top:8px"><button class="btn" style="padding:8px;font-size:13px" data-r="${CURRENT_ROUND.id}" data-h="${h.id}" onclick="openQuickLogForHole(this)">Add Shot</button></div>`; holesDiv.appendChild(col); });
    recentShots.appendChild(holesDiv);
    // handler for grid Add Shot buttons
    window.openQuickLogForHole = function(btn){ const hid = btn.getAttribute('data-h'); const idx = CURRENT_ROUND.holes.findIndex(x=>x.id===hid); if(idx>=0){ setActiveHoleIndex(CURRENT_ROUND, idx); saveRound(CURRENT_ROUND).then(()=> openQuickLogOrTee(CURRENT_ROUND)); } };
  }

  // total summary
  const totals = computeRoundTotals(CURRENT_ROUND);
  const summary = document.createElement('div'); summary.className='card'; summary.style.marginTop='10px'; summary.innerHTML = `<div class="row between"><div><strong>Round total</strong><div class="muted small">Holes: ${CURRENT_ROUND.holes.length}</div></div><div style="text-align:right"><div style="font-weight:700;font-size:18px">${totals.totalStrokes}</div><div class="muted small">Par ${totals.totalPar} • ${totals.diff>0? '+'+totals.diff : (totals.diff<0? totals.diff : 'E')}</div></div></div>`; recentShots.appendChild(summary);

  // append per-shot edit list under current-hole
  setTimeout(()=> appendPerShotEditList(), 40);
}

// openQuickLog wrapper for outside calls (exposed earlier)
function openQuickLog(round){ openQuickLog(round); } // we keep the main function name above

// openDetailedShotForm wrapper (keep existing interface)
function openDetailedShotFormById(btn){ const rId = btn.getAttribute('data-r'); const hId = btn.getAttribute('data-h'); if(!CURRENT_ROUND || CURRENT_ROUND.id !== rId){ loadAllRounds().then(rounds=>{ const r = rounds.find(rr=>rr.id===rId); if(!r) return alert('Round not found'); CURRENT_ROUND = r; const hole = r.holes.find(x=>x.id===hId); const idx = r.holes.findIndex(x=>x.id===hId); if(idx>=0) r.currentHole=idx; openDetailedShotForm(r,hole); }); } else { const hole = CURRENT_ROUND.holes.find(x=>x.id===hId); const idx = CURRENT_ROUND.holes.findIndex(x=>x.id===hId); if(idx>=0) CURRENT_ROUND.currentHole = idx; openDetailedShotForm(CURRENT_ROUND,hole); } }

// openQuickLogOrTee is used by Add Shot; ensure Add Shot button in UI calls it — already wired in renderActiveRound

// init
(async function init(){
  const d = new Date().toISOString().slice(0,10);
  document.getElementById('roundDate').value = d;
  document.getElementById('menuBtn').onclick = ()=> openSettings();
  if('serviceWorker' in navigator){ try{ await navigator.serviceWorker.register('/sw.js'); }catch(e){ console.warn('sw failed', e); } }
  injectLocalCourseButton();
  await renderRoundsList();
  renderActiveRound();
})();

// Note: helper forward-declarations to satisfy usage:
async function openQuickLog(round){ /* defined earlier in file - kept for clarity */ }
async function loadAllRounds(){ return (await (async function(){ const db = await openDB(); return new Promise((res,rej)=>{ const tx = db.transaction(STORE,'readonly').objectStore(STORE).getAll(); tx.onsuccess = ()=> res(tx.result || []); tx.onerror = ()=> rej(tx.error); }); })()); }
