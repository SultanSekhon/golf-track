

<script>
/*
  Golf CSV Analyzer (client-side)
  - heuristically maps columns
  - groups by round+hole and reconstructs shot sequences
  - computes empirical strokes-gained using dataset averages by distance bins
  - computes GIR, FIR, Scrambling, putting average
  - aggregates per-club SG and flags problematic clubs/mistakes
*/

/* ---------- Utilities ---------- */
function findHeader(headers, candidates) {
  const hLower = headers.map(h => h.toLowerCase());
  for (let c of candidates) {
    const idx = hLower.indexOf(c.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  // try contains
  for (let c of candidates) {
    for (let i=0;i<hLower.length;i++){
      if (hLower[i].includes(c.toLowerCase())) return headers[i];
    }
  }
  return null;
}
function toNum(v){ const n=parseFloat((v+'').replace(/[, ]+/g,'')); return isNaN(n)?null:n; }
function prettyPercent(n){ return (n==null?'-':(Math.round(n*1000)/10)+'%'); }
function mean(arr){ if(!arr || arr.length===0) return null; return arr.reduce((a,b)=>a+b,0)/arr.length; }

/* ---------- Main processing ---------- */
document.getElementById('file').addEventListener('change', (e)=>{
  const f = e.target.files[0]; if(!f) return;
  document.getElementById('status').textContent = 'Parsing...';
  Papa.parse(f, {
    header: true, skipEmptyLines:true,
    dynamicTyping:false,
    complete: function(res){
      document.getElementById('status').textContent = '';
      analyzeCSV(res.meta.fields, res.data);
    }
  });
});

document.getElementById('example').addEventListener('click', ()=>{
  const csv = `round_id,hole,par,shot_number,club,from_surface,dist_to_hole_before_m,dist_to_hole_after_m,shot_result,fairway_hit,putts_for_hole
1,1,4,1,Driver,Tee,280,200,fairway,true,
1,1,4,2,5-iron,Fairway,200,30,approach,false,
1,1,4,3,Putter,Green,30,0,holed,false,2
1,2,3,1,8-iron,Tee,120,12,green,,,
1,2,3,2,Putter,Green,12,0,holed,, ,1
`;
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='example_shots.csv'; a.click();
});

async function analyzeCSV(headers, rows){
  // Map headers heuristically
  const headerList = headers;
  const map = {};
  map.round = findHeader(headerList, ['round','round_id','game','session']) || null;
  map.hole = findHeader(headerList, ['hole','hole_number','hole_no']) || null;
  map.par = findHeader(headerList, ['par','hole_par']) || null;
  map.shotNumber = findHeader(headerList, ['shot_number','shotno','shot']) || null;
  map.club = findHeader(headerList, ['club','club_name','club_used']) || null;
  map.distBefore = findHeader(headerList, ['dist_to_hole_before','distance_to_hole_before','dist_before','distance_before','dist_to_pin','distance_to_pin','to_hole']) || null;
  map.distAfter = findHeader(headerList, ['dist_to_hole_after','distance_to_hole_after','dist_after','distance_after','left_to_hole','left_distance']) || null;
  map.shotResult = findHeader(headerList, ['shot_result','result','surface','outcome','target']) || null;
  map.fairway = findHeader(headerList, ['fairway','fir','fairway_hit']) || null;
  map.greenHit = findHeader(headerList, ['gir','green','green_hit','green_in_regulation']) || null;
  map.putts = findHeader(headerList, ['putts','putts_for_hole','putts_on_hole','num_putts']) || null;
  map.holedFlag = findHeader(headerList, ['holed','in_hole','is_hole','is_holed']) || null;
  // put a diagnostics box
  const diag = document.getElementById('diagnostics');
  diag.innerHTML = `<strong>Detected columns (heuristic):</strong><pre>${JSON.stringify(map, null, 2)}</pre>
    <small>Note: if important columns are missing (distances, shot ordering, club), results will be approximate.</small>`;

  // normalize rows: attach parsed values
  const data = rows.map((r, idx) => {
    return {
      __rowIndex: idx,
      raw: r,
      round: map.round ? r[map.round] : '1',
      hole: map.hole ? (r[map.hole] || '') : '',
      par: map.par ? toNum(r[map.par]) : null,
      shotNumber: map.shotNumber ? toNum(r[map.shotNumber]) : null,
      club: map.club ? (r[map.club]||'Unknown') : 'Unknown',
      distBefore: map.distBefore ? toNum(r[map.distBefore]) : null,
      distAfter: map.distAfter ? toNum(r[map.distAfter]) : null,
      shotResult: map.shotResult ? (''+ (r[map.shotResult]||'')).toLowerCase() : '',
      fairway: map.fairway ? (''+ (r[map.fairway]||'')).toLowerCase() : null,
      greenHit: map.greenHit ? (''+ (r[map.greenHit]||'')).toLowerCase() : null,
      putts_for_hole: map.putts ? toNum(r[map.putts]) : null,
      holedFlag: map.holedFlag ? (''+ (r[map.holedFlag]||'')).toLowerCase() : null
    };
  });

  // Group by round+hole
  const groups = {};
  for (let r of data) {
    const key = `${r.round}||${r.hole}`;
    if (!groups[key]) groups[key] = {round:r.round, hole:r.hole, par:r.par, shots:[]};
    groups[key].shots.push(r);
  }
  // sort shots within hole by shotNumber if available else by original order
  for (let k in groups) {
    groups[k].shots.sort((a,b)=>{
      if (a.shotNumber!=null && b.shotNumber!=null) return a.shotNumber - b.shotNumber;
      return a.__rowIndex - b.__rowIndex;
    });
  }

  // For each shot compute observed strokes left after that shot (in that hole) = number of shots remaining in that hole
  const allShots = [];
  for (let k in groups) {
    const hole = groups[k];
    const n = hole.shots.length;
    for (let i=0;i<n;i++){
      const shot = hole.shots[i];
      shot.inHoleIndex = i;
      shot.shotsRemaining_after = n - 1 - i; // shots still to be played in that hole after this shot
      // if any later shot has holed flag or distAfter==0, we can set holed position; but shotsRemaining_after already reflects real outcome.
      allShots.push(shot);
    }
  }

  // Build empirical expectation table: for distance-before bins, average strokesRemaining_before
  // We'll use bins: 0-3,3-8,8-15,15-30,30-50,50-80,80-120,120-150,150-200,200-300,300+
  const bins = [0,3,8,15,30,50,80,120,150,200,300,10000];
  function binLabel(d){
    if (d==null) return 'unknown';
    for (let i=0;i<bins.length-1;i++){
      if (d >= bins[i] && d < bins[i+1]) return `${bins[i]}-${bins[i+1]-1}`;
    }
    return `${bins[bins.length-2]}+`;
  }
  const statsByBin = {}; // for distBefore
  for (let s of allShots){
    const d = s.distBefore;
    const label = binLabel(d);
    if (!statsByBin[label]) statsByBin[label] = {samples:0, sumAfter:0, afters:[]};
    // strokesRemaining after this shot is observed. That is our empirical "strokes to hole after this shot".
    statsByBin[label].samples++;
    statsByBin[label].sumAfter += s.shotsRemaining_after;
    statsByBin[label].afters.push(s.shotsRemaining_after);
  }
  // compute avg strokesRemaining_by_bin
  for (let b in statsByBin) {
    statsByBin[b].avgAfter = statsByBin[b].sumAfter / statsByBin[b].samples;
  }

  // Now compute strokes-gained per shot: expected_before - (1 + expected_after)
  // expected_before = avgAfter for bin of distBefore
  // expected_after = avgAfter for bin of distAfter  (if distAfter missing, try to use 0 if holed or fallback to same)
  for (let s of allShots){
    const beforeLabel = binLabel(s.distBefore);
    const afterLabel = binLabel(s.distAfter);
    const expBefore = statsByBin[beforeLabel] ? statsByBin[beforeLabel].avgAfter : null;
    // expected after: if distAfter is 0 or we see holed, expected_after = 0
    let expAfter = null;
    if (s.distAfter === 0 || (s.shotResult && s.shotResult.includes('hole')) || (s.holedFlag && s.holedFlag.includes('true'))) expAfter = 0;
    else expAfter = statsByBin[afterLabel] ? statsByBin[afterLabel].avgAfter : null;
    if (expBefore==null || expAfter==null) {
      s.sg = null;
    } else {
      // SG = expected_before - (1 + expected_after)
      s.sg = expBefore - (1 + expAfter);
    }
  }

  // Aggregate metrics
  const holes = Object.values(groups);
  const holesPlayed = holes.length;
  let totalStrokes = 0;
  let totalPutts = 0;
  let firAttempts = 0, firHits = 0;
  let girCount = 0, girAttempts = 0;
  let scrambleAttempts = 0, scrambleSuccess = 0;
  const clubAgg = {}; // club -> {shots, sumSG, sgSamples, shortCount, longCount, leftCount, rightCount, poorCount}
  for (let h of holes){
    // Count strokes for this hole = shots length
    totalStrokes += h.shots.length;
    // putts_for_hole might be present only on first shot row or on hole-level; try to find any putts value
    const puttVal = h.shots.find(s=>s.putts_for_hole!=null && !isNaN(s.putts_for_hole));
    if (puttVal) totalPutts += puttVal.putts_for_hole;
    else {
      // fallback: count shots with from_surface 'green' and shotResult holed? approximate putts as shots with "putter" club on green
      const putterShots = h.shots.filter(s => (''+s.club).toLowerCase().includes('putt') || (s.shotResult && s.shotResult.includes('putt')));
      totalPutts += putterShots.length;
    }

    // FIR: detect tee shot = shot index 0; only count for par 4 & par 5 holes
    if (h.par && (h.par==4 || h.par==5)) {
      const teeShot = h.shots[0];
      if (teeShot) {
        firAttempts++;
        let hit = false;
        if (teeShot.fairway!=null) {
          const f = (''+teeShot.fairway).toLowerCase();
          if (f==='true' || f==='1' || f.includes('y') || f.includes('hit') || f.includes('fairway')) hit=true;
        }
        if (teeShot.shotResult && teeShot.shotResult.includes('fair')) hit = true;
        if (hit) firHits++;
      }
    }

    // GIR: simple heuristic: did a shot reach the green in regulation?
    // We'll mark hole GIR true if any shot in hole has shotResult containing 'green' and that shot's index <= par-2 (i.e., on/within regulation)
    let holeGir = false;
    for (let s of h.shots) {
      if (s.shotResult && s.shotResult.includes('green')){
        // determine shot index: if shotNumber available use it, else inHoleIndex+1
        const sn = s.shotNumber!=null? s.shotNumber : (s.inHoleIndex+1);
        if (h.par!=null && sn <= (h.par - 1)) { // reaching green in par-1 or earlier
          holeGir = true; break;
        }
      }
      // if distAfter === 0 and inHoleIndex+1 <= par-1, that's a GIR (hole out on approach)
      if (s.distAfter === 0) {
        const sn = s.shotNumber!=null? s.shotNumber : (s.inHoleIndex+1);
        if (h.par!=null && sn <= (h.par - 1)) { holeGir = true; break; }
      }
    }
    if (h.par!=null) {
      girAttempts++;
      if (holeGir) girCount++;
    }

    // Scrambling: if not GIR and hole strokes <= par (par saved or better)
    let holeScore = h.shots.length;
    if (!holeGir && h.par!=null) {
      scrambleAttempts++;
      if (holeScore <= h.par) scrambleSuccess++;
    }

    // Club aggregates & mistake detection
    for (let s of h.shots) {
      const club = s.club || 'Unknown';
      if (!clubAgg[club]) clubAgg[club] = {shots:0, sumSG:0, sgSamples:0, short:0, long:0, left:0, right:0, neutral:0, rawShots:[]};
      const a = clubAgg[club];
      a.shots++;
      a.rawShots.push(s);
      if (s.sg!=null) { a.sumSG += s.sg; a.sgSamples++; }
      // Basic mistake heuristics:
      // - if distAfter is null or distBefore is null we can't do much
      if (s.distBefore!=null && s.distAfter!=null) {
        const delta = s.distBefore - s.distAfter; // positive means you reduced distance
        if (delta < 0) a.long++;
        else if (delta < (s.distBefore * 0.15) && s.distBefore > 30) a.neutral++;
        else a.short += (delta>0 && delta < 5) ? 1 : 0; // tiny reduction = short
      }
      // left/right detection requires lateral info -> we look for columns like 'left_right' or shotResult includes left/right
      if (s.shotResult) {
        if (s.shotResult.includes('left')) a.left++;
        if (s.shotResult.includes('right')) a.right++;
      }
    }
  }

  // Summary numbers
  const scoringAvg = (holesPlayed>0) ? (totalStrokes / holesPlayed) : null;
  const puttingAvg = (holesPlayed>0) ? (totalPutts / holesPlayed) : null;
  const firPct = (firAttempts>0) ? (firHits / firAttempts) : null;
  const girPct = (girAttempts>0) ? (girCount / girAttempts) : null;
  const scramblePct = (scrambleAttempts>0) ? (scrambleSuccess / scrambleAttempts) : null;

  // Per-club sort by average SG ascending (worst first)
  const clubList = Object.keys(clubAgg).map(c=>{
    const o = clubAgg[c];
    return {
      club: c,
      shots: o.shots,
      avgSG: (o.sgSamples>0) ? (o.sumSG / o.sgSamples) : null,
      sgSamples: o.sgSamples,
      short: o.short, long: o.long, left: o.left, right: o.right, neutral: o.neutral
    };
  }).sort((a,b)=>{
    if (a.avgSG==null && b.avgSG==null) return b.shots - a.shots;
    if (a.avgSG==null) return 1;
    if (b.avgSG==null) return -1;
    return a.avgSG - b.avgSG; // worst (most negative) first
  });

  // Determine "most problematic" clubs — ones with lowest avgSG and reasonable sample count
  const problematic = clubList.filter(c => c.avgSG!=null && c.shots>=5).slice(0,5);

  // Most common mistakes overall: examine clubAgg raw counts
  const mistakeTotals = {short:0,long:0,left:0,right:0,neutral:0};
  for (let c of clubList) {
    mistakeTotals.short += c.short;
    mistakeTotals.long += c.long;
    mistakeTotals.left += c.left;
    mistakeTotals.right += c.right;
    mistakeTotals.neutral += c.neutral;
  }
  // pick top mistake
  const mistakeRank = Object.entries(mistakeTotals).sort((a,b)=>b[1]-a[1]);
  const topMistake = mistakeRank[0] && mistakeRank[0][1]>0 ? mistakeRank[0][0] : 'unknown';

  // Build outputs
  const summary = document.getElementById('summary');
  summary.innerHTML = `<strong>Summary (${holesPlayed} holes, ${allShots.length} shots)</strong>
    <table>
      <tr><th>Strokes total</th><td>${totalStrokes}</td></tr>
      <tr><th>Scoring average (strokes/hole)</th><td>${scoringAvg? (Math.round(scoringAvg*100)/100) : '-'}</td></tr>
      <tr><th>Putting average (putts/hole)</th><td>${puttingAvg? (Math.round(puttingAvg*100)/100) : '-'}</td></tr>
      <tr><th>FIR % (par4/5 only)</th><td>${firPct!=null? prettyPercent(firPct): '-'}</td></tr>
      <tr><th>GIR %</th><td>${girPct!=null? prettyPercent(girPct): '-'}</td></tr>
      <tr><th>Scrambling % (when missed GIR)</th><td>${scramblePct!=null? prettyPercent(scramblePct): '-'}</td></tr>
      <tr><th>Average empirical SG per shot (dataset mean)</th><td>${(function(){ const s = allShots.filter(x=>x.sg!=null).map(x=>x.sg); return s.length? (Math.round((s.reduce((a,b)=>a+b,0)/s.length)*100)/100) : 'insufficient data' })()}</td></tr>
    </table>
    <p><strong>Top problematic clubs (by avg strokes-gained, worst first; min 5 shots):</strong></p>
    ${problematic.length? `<ol>${problematic.map(p=>`<li>${p.club} — avg SG ${(Math.round(p.avgSG*100)/100)} over ${p.shots} shots</li>`).join('')}</ol>` : '<em>Not enough data or no club with >=5 shots.</em>'}
    <p><strong>Most common mistake type overall (heuristic):</strong> ${topMistake}</p>
    <p><small><strong>Notes & assumptions:</strong> This tool uses only data available in your CSV. It builds an <em>empirical</em> expected strokes table by distance bins from your dataset and computes strokes gained as: <code>SG = expected_before - (1 + expected_after)</code>. This is a dataset-driven approximation — if your file has few samples for a distance, SG may be noisy. Columns that help accuracy: <em>dist_to_hole_before, dist_to_hole_after, club, shot_number, shot_result</em>. If those are missing the results will be approximate.</small></p>
  `;

  // Per-club table
  const perClubDiv = document.getElementById('perClub');
  perClubDiv.innerHTML = `<strong>Per-club summary (top 30)</strong>
    <table><thead><tr><th>Club</th><th>Shots</th><th>Avg SG</th><th>SG samples</th><th>Short</th><th>Long</th><th>Left</th><th>Right</th></tr></thead>
    <tbody>
      ${clubList.slice(0,30).map(c=>`<tr>
        <td>${c.club}</td>
        <td>${c.shots}</td>
        <td>${c.avgSG!=null? (Math.round(c.avgSG*100)/100) : '-'}</td>
        <td>${c.sgSamples}</td>
        <td>${c.short}</td><td>${c.long}</td><td>${c.left}</td><td>${c.right}</td>
      </tr>`).join('')}
    </tbody></table>`;


  // Mistakes breakdown
  const mistakesDiv = document.getElementById('mistakes');
  mistakesDiv.innerHTML = `<strong>Mistakes summary</strong>
    <p>Counts (heuristic): short: ${mistakeTotals.short}, long: ${mistakeTotals.long}, left: ${mistakeTotals.left}, right: ${mistakeTotals.right}</p>
    <p><strong>Distance-bin stats (samples → avg shots remaining after a shot)</strong></p>
    <table><thead><tr><th>Bin (m)</th><th>Samples</th><th>Avg strokes remaining after shot</th></tr></thead>
    <tbody>
      ${Object.entries(statsByBin).map(([b,v])=>`<tr><td>${b}</td><td>${v.samples}</td><td>${v.avgAfter? (Math.round(v.avgAfter*100)/100) : '-'}</td></tr>`).join('')}
    </tbody></table>
    <p><em>If you'd like, I can:</em></p>
    <ul>
      <li>Export a per-shot CSV with computed SG values and flags</li>
      <li>Produce a chart of club SG over time</li>
      <li>Use a known strokes-gained model (requires external baseline table)</li>
    </ul>
  `;
}
</script>
