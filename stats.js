(function(){
  const BTN_ID = 'showStatsBtn';
  const DB_NAME = 'golftrack-db-v1';
  const STORE = 'rounds';
  const REFRESH_MS = 10000; // 10s

  const getLiveCsvUrl = () => window.GOLFTRACK_LIVE_CSV_URL || '';

  // CSV parser (quoted fields)
  function parseCSV(text){
    if(!text || !text.trim()) return { header: [], rows: [] };
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l=>l.length>0);
    const rows = lines.map(line=>{
      const out = [];
      let cur = '';
      let inQ = false;
      for(let i=0;i<line.length;i++){
        const ch = line[i];
        if(inQ){
          if(ch==='"'){
            if(line[i+1]==='"'){ cur+='"'; i++; }
            else { inQ=false; }
          } else cur += ch;
        } else {
          if(ch===','){ out.push(cur); cur=''; }
          else if(ch==='"'){ inQ = true; }
          else cur += ch;
        }
      }
      out.push(cur);
      return out;
    });
    const header = rows.shift() || [];
    return { header, rows };
  }

  function indexCols(header){
    const idx = Object.create(null);
    header.forEach((h,i)=>{ idx[String(h).replace(/^\"|\"$/g,'')] = i; });
    return idx;
  }

  // IndexedDB (read-only)
  function openDB(){
    return new Promise((res,rej)=>{
      const req = indexedDB.open(DB_NAME,1);
      req.onsuccess = ()=> res(req.result);
      req.onerror = ()=> rej(req.error);
    });
  }
  async function loadAllRounds(){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readonly');
      const st = tx.objectStore(STORE).getAll();
      st.onsuccess = ()=> res(st.result || []);
      st.onerror = ()=> rej(st.error);
    });
  }

  function computeHoleStrokes(hole){
    const shots = hole.shots || [];
    const totalShotEntries = shots.length;
    const puttShots = shots.filter(s => (s.strokeType||'').toLowerCase() === 'putt').length;
    const extraPutts = hole.putts || 0;
    const penalties = (hole.penalties && hole.penalties.length) ? hole.penalties.reduce((acc,p)=>acc + (p.strokes||1), 0) : 0;
    const strokes = totalShotEntries + extraPutts + penalties - puttShots;
    return Math.max(strokes, totalShotEntries + penalties);
  }
  function computeFIR(hole){
    const par = hole.par || 0;
    if(par <= 3) return false;
    if(!hole.shots || hole.shots.length === 0) return false;
    const secondShot = hole.shots[1];
    return !!(secondShot && secondShot.lie === 'Fairway');
  }
  function computeGIR(hole){
    const par = hole.par || 0;
    if(par === 0) return false;
    const shots = hole.shots || [];
    const puttShots = shots.filter(s => (s.strokeType||'').toLowerCase() === 'putt');
    const nonPuttShots = shots.length - puttShots.length;
    if(par === 3) return nonPuttShots === 1;
    if(par === 4) return nonPuttShots === 2;
    if(par === 5) return nonPuttShots === 3;
    return false;
  }
  function compute2Putt(hole){
    const putts = hole.putts || 0;
    return putts === 0 || putts === 1 || putts === 2;
  }

  function aggregateFromRounds(rounds){
    const strokeCounts = Object.create(null);
    const clubCounts = Object.create(null);
    const teeClubCounts = Object.create(null);
    let totalShots = 0;
    let putt0=0, putt1=0, putt2=0, putt3p=0;
    let firCount=0, girCount=0, twoPuttCount=0;
    let totalHoles = 0;

    (rounds||[]).forEach(r=>{
      (r.holes||[]).forEach(h=>{
        totalHoles++;
        if(computeFIR(h)) firCount++;
        if(computeGIR(h)) girCount++;
        if(compute2Putt(h)) twoPuttCount++;
        const p = h.putts||0;
        if(p===0) putt0++; else if(p===1) putt1++; else if(p===2) putt2++; else putt3p++;
        (h.shots||[]).forEach(s=>{
          totalShots++;
          const st = s.strokeType || '';
          const cl = s.club || '';
          if(st) strokeCounts[st] = (strokeCounts[st]||0) + 1;
          if(cl) clubCounts[cl] = (clubCounts[cl]||0) + 1;
          if(s.isTee && cl) teeClubCounts[cl] = (teeClubCounts[cl]||0) + 1;
        });
      });
    });

    return {
      totals: { totalShots, totalHoles, firCount, girCount, twoPuttCount },
      strokes: strokeCounts,
      clubs: clubCounts,
      teeClubs: teeClubCounts,
      putting: { putt0, putt1, putt2, putt3p }
    };
  }

  function aggregateFromCSV(header, rows){
    const i = indexCols(header);
    const get = (r, key) => {
      const ix = i[key];
      if(ix == null) return '';
      return r[ix] != null ? String(r[ix]).replace(/^\"|\"$/g,'') : '';
    };

    const holes = new Map();
    const strokeCounts = Object.create(null);
    const clubCounts = Object.create(null);
    const teeClubCounts = Object.create(null);
    let totalShots = 0;

    rows.forEach(r=>{
      const roundId = get(r, 'round_id');
      const hole = get(r, 'hole');
      if(!roundId || !hole) return;
      const key = roundId + '|' + hole;

      const putts = Number(get(r,'putts')) || 0;
      const fir = get(r,'fir') === '1' || /^(yes|true)$/i.test(get(r,'fir'));
      const gir = get(r,'gir') === '1' || /^(yes|true)$/i.test(get(r,'gir'));
      const two = get(r,'2putt') === '1' || /^(yes|true)$/i.test(get(r,'2putt'));
      holes.set(key, { putts, fir, gir, twoPutt: two });

      const shotId = get(r,'shot_id');
      const club = get(r,'club');
      const stroke = get(r,'stroke');
      const isTee = get(r,'shot_is_tee') === '1';
      if(shotId){
        totalShots++;
        if(stroke) strokeCounts[stroke] = (strokeCounts[stroke]||0) + 1;
        if(club) clubCounts[club] = (clubCounts[club]||0) + 1;
        if(isTee && club) teeClubCounts[club] = (teeClubCounts[club]||0) + 1;
      }
    });

    let putt0=0, putt1=0, putt2=0, putt3p=0;
    let firCount=0, girCount=0, twoPuttCount=0;
    holes.forEach(h=>{
      if(h.putts===0) putt0++; else if(h.putts===1) putt1++; else if(h.putts===2) putt2++; else putt3p++;
      if(h.fir) firCount++;
      if(h.gir) girCount++;
      if(h.twoPutt) twoPuttCount++;
    });

    const totalHoles = holes.size;

    return {
      totals: { totalShots, totalHoles, firCount, girCount, twoPuttCount },
      strokes: strokeCounts,
      clubs: clubCounts,
      teeClubs: teeClubCounts,
      putting: { putt0, putt1, putt2, putt3p }
    };
  }

  function mergeStats(a,b){
    if(!a) return b; if(!b) return a;
    const sumObj = (x,y)=>{ const out = {...x}; Object.entries(y).forEach(([k,v])=>{ out[k] = (out[k]||0)+v; }); return out; };
    return {
      totals: {
        totalShots: (a.totals.totalShots||0) + (b.totals.totalShots||0),
        totalHoles: (a.totals.totalHoles||0) + (b.totals.totalHoles||0),
        firCount: (a.totals.firCount||0) + (b.totals.firCount||0),
        girCount: (a.totals.girCount||0) + (b.totals.girCount||0),
        twoPuttCount: (a.totals.twoPuttCount||0) + (b.totals.twoPuttCount||0)
      },
      strokes: sumObj(a.strokes,b.strokes),
      clubs: sumObj(a.clubs,b.clubs),
      teeClubs: sumObj(a.teeClubs,b.teeClubs),
      putting: {
        putt0: (a.putting.putt0||0) + (b.putting.putt0||0),
        putt1: (a.putting.putt1||0) + (b.putting.putt1||0),
        putt2: (a.putting.putt2||0) + (b.putting.putt2||0),
        putt3p: (a.putting.putt3p||0) + (b.putting.putt3p||0)
      }
    };
  }

  function pct(part, total){ if(!total) return '0%'; return Math.round((part/total)*100) + '%'; }

  // ---------- Overlay-based UI ----------
  function getOverlay(){ return document.getElementById('overlay'); }
  function openOverlay(){ const ov = getOverlay(); ov.classList.remove('hidden'); return ov; }
  function closeOverlay(){
    const ov = getOverlay();
    ov.classList.add('hidden');
    ov.innerHTML = '';
  }

  function buildPanel(){
    // Use the same bottom-sheet "form" container as other dialogs
    const sheet = document.createElement('div');
    sheet.className = 'form';
    sheet.setAttribute('id','statsSheet');

    // Header with close button (×)
    const header = document.createElement('div');
    header.className = 'row between';
    header.style.marginBottom = '6px';
    header.innerHTML = `
      <div style="font-weight:800">Live Stats</div>
      <button class="iconBtn" id="statsCloseBtn" aria-label="Close" title="Close">✕</button>
    `;

    // Tabs + content wrapper
    const tabs = document.createElement('div');
    tabs.style.display = 'flex'; tabs.style.gap = '8px'; tabs.style.alignItems = 'center'; tabs.style.marginBottom = '8px';

    const strokeBtn = document.createElement('button'); strokeBtn.textContent = 'Stroke Stats'; strokeBtn.className='btn';
    const clubBtn   = document.createElement('button'); clubBtn.textContent   = 'Club Stats';   clubBtn.className='btn';
    const liveInfo  = document.createElement('div'); liveInfo.className='muted small'; liveInfo.style.marginLeft='auto'; liveInfo.textContent='Live refresh: 10s';

    tabs.appendChild(strokeBtn); tabs.appendChild(clubBtn); tabs.appendChild(liveInfo);

    const content = document.createElement('div');

    sheet.appendChild(header);
    sheet.appendChild(tabs);
    sheet.appendChild(content);

    return { sheet, strokeBtn, clubBtn, content, closeBtnId: 'statsCloseBtn' };
  }

  function renderStroke(stats, mount){
    mount.innerHTML = '';
    const h = document.createElement('h3'); h.textContent='Stroke Stats'; h.style.marginTop='0'; mount.appendChild(h);

    const meta = document.createElement('div'); meta.className='muted small';
    const t = stats.totals;
    const firRate = pct(t.firCount, t.totalHoles);
    const girRate = pct(t.girCount, t.totalHoles);
    const twoRate = pct(t.twoPuttCount, t.totalHoles);
    meta.textContent = `Shots: ${t.totalShots} • Holes: ${t.totalHoles} • FIR: ${t.firCount} (${firRate}) • GIR: ${t.girCount} (${girRate}) • 2-Putt Holes: ${t.twoPuttCount} (${twoRate})`;
    mount.appendChild(meta);

    const s1 = document.createElement('div'); s1.style.marginTop='8px'; s1.innerHTML = '<strong>Shots by stroke type</strong>';
    s1.appendChild(kvListWithPct(stats.strokes, t.totalShots));

    const s2 = document.createElement('div'); s2.style.marginTop='8px'; s2.innerHTML = '<strong>Putting distribution (per hole)</strong>';
    const holes = t.totalHoles || 0;
    s2.appendChild(kvListWithPct({ '0 putts': stats.putting.putt0, '1 putt': stats.putting.putt1, '2 putts': stats.putting.putt2, '3+ putts': stats.putting.putt3p }, holes));

    mount.appendChild(s1); mount.appendChild(s2);
  }

  function renderClub(stats, mount){
    mount.innerHTML = '';
    const h = document.createElement('h3'); h.textContent='Club Stats'; h.style.marginTop='0'; mount.appendChild(h);

    const t = stats.totals;

    const s1 = document.createElement('div'); s1.style.marginTop='8px'; s1.innerHTML = '<strong>Usage by club</strong>';
    s1.appendChild(kvListWithPct(stats.clubs, t.totalShots));

    const s2 = document.createElement('div'); s2.style.marginTop='8px'; s2.innerHTML = '<strong>Tee shots by club</strong>';
    s2.appendChild(kvListWithPct(stats.teeClubs, t.totalShots));

    mount.appendChild(s1); mount.appendChild(s2);
  }

  let refreshTimer = null;
  let currentTab = 'stroke';
  let overlayClickHandler = null;
  let escHandler = null;

  async function loadStats(){
    let stats = aggregateFromRounds(await loadAllRounds());
    const url = getLiveCsvUrl();
    if(url){
      try{
        const res = await fetch(url, { cache: 'no-store' });
        if(res.ok){
          const text = await res.text();
          const parsed = parseCSV(text);
          const statsCsv = aggregateFromCSV(parsed.header, parsed.rows);
          stats = mergeStats(stats, statsCsv);
        }
      }catch(e){ /* ignore CSV fetch errors */ }
    }
    return stats;
  }

  async function openStats(){
    const ov = openOverlay();

    // Clear any existing content (and timers) before re-opening
    if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
    ov.innerHTML = '';

    // Build sheet UI
    const { sheet, strokeBtn, clubBtn, content, closeBtnId } = buildPanel();
    ov.appendChild(sheet);

    // Initial render
    async function refresh(){
      const stats = await loadStats();
      if(currentTab === 'club') renderClub(stats, content);
      else renderStroke(stats, content);
    }
    strokeBtn.onclick = ()=>{ currentTab='stroke'; refresh(); };
    clubBtn.onclick   = ()=>{ currentTab='club';   refresh(); };

    // Close actions
    sheet.querySelector('#'+closeBtnId).onclick = closeStats;

    // Tap-outside to close
    overlayClickHandler = (e)=>{
      if(e.target === ov){ closeStats(); }
    };
    ov.addEventListener('click', overlayClickHandler);

    // ESC to close
    escHandler = (e)=>{
      if(e.key === 'Escape'){ closeStats(); }
    };
    document.addEventListener('keydown', escHandler);

    // Start live refresh
    await refresh();
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  function closeStats(){
    if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
    const ov = getOverlay();
    if(overlayClickHandler){ ov.removeEventListener('click', overlayClickHandler); overlayClickHandler = null; }
    if(escHandler){ document.removeEventListener('keydown', escHandler); escHandler = null; }
    closeOverlay();
  }

  // Mount: wire up the existing "Stats" button
  function attach(){
    let btn = document.getElementById(BTN_ID);
    if(!btn){
      // Fallback: create one near the bottom if missing
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.textContent = 'Stats';
      btn.className = 'btn';
      document.body.appendChild(btn);
    }
    btn.addEventListener('click', openStats);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', attach, { once:true });
  else attach();
})();
