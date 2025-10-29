/* practice-session.js

Implementation for Practice Range Sessions
Features:
- Practice types: putting, chipping, long shots (stored as practiceType)
- Lock-in initial parameters (club, lie, practiceType, distance, target) so player doesn't re-enter each shot
- Fast bulk-logging: log N repeated shots after a single confirmation
- Ability to change club or surface (grass <-> mat) mid-session and have subsequent shots use the updated defaults
- IndexedDB persistence (uses same DB_NAME / STORE convention as course logging)

Integration notes:
- This file is plain JavaScript meant to plug into the existing GolfTrack front-end.
- It expects `DB_NAME` and `STORE` constants or will fall back to defaults below.
- `uid()` helper is used for unique ids (if your project has a different uid, replace it).

USAGE EXAMPLES (bottom of file).
*/

// -- Config / helpers (adapt to your app's existing helpers) --
const PRACTICE_DB_NAME = typeof DB_NAME !== 'undefined' ? DB_NAME : 'golftrack-db-v1';
const PRACTICE_STORE = 'practice_shots';
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8) }

// IndexedDB simple helper - creates a DB and object store for practice shots
function openPracticeDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PRACTICE_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(PRACTICE_STORE)){
        db.createObjectStore(PRACTICE_STORE, { keyPath: 'id' });
      }
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addPracticeShotsToDB(shots){
  const db = await openPracticeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PRACTICE_STORE, 'readwrite');
    const store = tx.objectStore(PRACTICE_STORE);
    shots.forEach(s => store.put(s));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB tx error'));
  });
}

// -- PracticeSession class --
class PracticeSession {
  constructor({playerId=null, locked=false} = {}){
    this.sessionId = uid();
    this.playerId = playerId;
    // lockedDefaults: the single-input params that apply to shots until changed.
    this.lockedDefaults = {
      club: 'Putter',    // example default
      practiceType: 'putting', // 'putting' | 'chipping' | 'long'
      lie: 'grass',      // 'grass' | 'mat'
      distance: 5,       // yards/meters depending on user's units
      target: null,      // free text or coordinates
      stanceNotes: '',
    };

    // autoLock: when true, every logged shot uses lockedDefaults unless explicit overrides provided
    this.autoLock = locked;

    // history for this session (in-memory). Persisted to DB on demand or periodically.
    this.shots = [];

    // event listeners map (simple pub/sub for UI updates)
    this.listeners = {};
  }

  on(event, fn){ (this.listeners[event] = this.listeners[event] || []).push(fn); }
  emit(event, payload){ (this.listeners[event] || []).forEach(fn => fn(payload)); }

  // Set initial locked parameters (single input). This is the 'lock-in' user wants.
  setLockedDefaults(partial){
    this.lockedDefaults = Object.assign({}, this.lockedDefaults, partial);
    this.emit('lockedDefaultsChanged', this.lockedDefaults);
  }

  // Toggle whether the session automatically uses the locked defaults.
  setAutoLock(flag){ this.autoLock = !!flag; this.emit('autoLockChanged', this.autoLock); }

  // Change current club mid-session; subsequent shots will use the new locked club
  changeClub(newClub){
    this.lockedDefaults.club = newClub;
    this.emit('clubChanged', newClub);
  }

  // Change the playing surface (grass <-> mat); subsequent shots will use the new surface.
  changeSurface(newSurface){
    if(!['grass','mat'].includes(newSurface)) throw new Error('unsupported surface');
    this.lockedDefaults.lie = newSurface;
    this.emit('surfaceChanged', newSurface);
  }

  // Build a single shot record using session defaults and overrides
  _buildShotRecord(overrides={}){
    const base = Object.assign({}, this.lockedDefaults);
    const shot = Object.assign({}, base, overrides);
    const timestamp = new Date().toISOString();
    return {
      id: uid(),
      sessionId: this.sessionId,
      playerId: this.playerId,
      practiceType: shot.practiceType, // putting|chipping|long
      club: shot.club,
      lie: shot.lie,
      distance: shot.distance,
      target: shot.target || null,
      result: shot.result || null, // e.g., 'on green', 'short', 'fat', 'thin', 'miss-left'
      notes: shot.notes || '',
      createdAt: timestamp,
    };
  }

  // Log shots quickly without prompting every time.
  async logShots({count=1, overrides={}} = {}){
    if(count < 1) count = 1;
    const shots = [];
    for(let i=0;i<count;i++){
      const shotRecord = this._buildShotRecord(overrides);
      shots.push(shotRecord);
      this.shots.push(shotRecord);
    }

    try{
      await addPracticeShotsToDB(shots);
      this.emit('shotsLogged', {count: shots.length, shots});
      return shots;
    }catch(err){
      console.error('Failed to persist practice shots', err);
      this.emit('error', err);
      throw err;
    }
  }

  async logBatch(arrayOfOverrides){
    const shots = arrayOfOverrides.map(o => this._buildShotRecord(o));
    this.shots.push(...shots);
    await addPracticeShotsToDB(shots);
    this.emit('shotsLogged', {count: shots.length, shots});
    return shots;
  }

  async endSession(){
    const summary = this.getSummary();
    this.emit('sessionEnded', summary);
    return summary;
  }

  getSummary(){
    const totals = {putting:0,chipping:0,long:0};
    this.shots.forEach(s => { totals[s.practiceType] = (totals[s.practiceType]||0)+1 });
    return {
      sessionId: this.sessionId,
      playerId: this.playerId,
      shotCount: this.shots.length,
      byType: totals,
      lockedDefaults: Object.assign({}, this.lockedDefaults),
      createdAt: new Date().toISOString(),
    };
  }
}

function setupPracticeUI(){
  const session = new PracticeSession({playerId: 'player-1', locked: true});

  session.on('lockedDefaultsChanged', d => console.log('defaults', d));
  session.on('shotsLogged', info => console.log('logged', info.count, 'shots'));

  const clubEl = document.getElementById('ps-club');
  const typeEl = document.getElementById('ps-type');
  const distEl = document.getElementById('ps-distance');
  const lieEl = document.getElementById('ps-lie');
  const lockBtn = document.getElementById('ps-lockDefaults');
  const repsEl = document.getElementById('ps-reps');
  const logRepsBtn = document.getElementById('ps-logReps');
  const switchSurfaceBtn = document.getElementById('ps-switchSurface');

  if(clubEl){ ['Putter','Sand Wedge','Pitching Wedge','9-iron','7-iron','5-iron','3-wood','Driver'].forEach(c=>{
    const o = document.createElement('option'); o.value = c; o.textContent = c; clubEl.appendChild(o);
  })}

  if(typeEl){ ['putting','chipping','long'].forEach(t=>{ const o=document.createElement('option'); o.value=t; o.textContent=t; typeEl.appendChild(o); }) }

  lockBtn && lockBtn.addEventListener('click', ()=>{
    session.setLockedDefaults({
      club: clubEl ? clubEl.value : session.lockedDefaults.club,
      practiceType: typeEl ? typeEl.value : session.lockedDefaults.practiceType,
      distance: distEl ? Number(distEl.value) : session.lockedDefaults.distance,
      lie: lieEl ? lieEl.value : session.lockedDefaults.lie,
    });
    session.setAutoLock(true);
    alert('Defaults locked — subsequent logs will use these values unless you change them.');
  });

  logRepsBtn && logRepsBtn.addEventListener('click', async ()=>{
    const count = Number(repsEl ? repsEl.value : 1) || 1;
    try{
      await session.logShots({count});
      alert(`Logged ${count} practice shots using locked defaults.`);
    }catch(e){ alert('Failed to log shots: '+e.message) }
  });

  switchSurfaceBtn && switchSurfaceBtn.addEventListener('click', ()=>{
    const newSurface = session.lockedDefaults.lie === 'grass' ? 'mat' : 'grass';
    session.changeSurface(newSurface);
    if(lieEl) lieEl.value = newSurface;
    alert('Surface switched to: '+newSurface + '\nFuture practice shots will use this surface.');
  });

  return session;
}

if(typeof module !== 'undefined' && module.exports) module.exports = { PracticeSession, setupPracticeUI };
