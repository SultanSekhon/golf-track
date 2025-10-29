<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Golf — Standard CSV Analyzer</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:system-ui, -apple-system, "Segoe UI", Roboto, Arial; padding:18px; color:#111}
    h1{margin:0 0 8px 0}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    .box{border:1px solid #e6e6e6;padding:12px;border-radius:8px;background:#fafafa;margin-top:12px}
    table{border-collapse:collapse;width:100%;margin-top:8px}
    th,td{padding:6px 8px;border:1px solid #efefef;text-align:left;font-size:13px}
    .muted{color:#666;font-size:13px}
    button{padding:8px 12px;border-radius:6px;border:1px solid #bbb;background:#fff;cursor:pointer}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
</head>
<body>
  <h1>Golf — Standard CSV Analyzer</h1>
  <p class="muted">Drop the export CSV (shot-by-shot) that matches the standard export you uploaded. This analyzer expects columns like <code>round_id,hole,par,club,stroke,strokes,putts,shot_is_tee,fir,gir,outcome</code>.</p>

  <div class="row">
    <input id="file" type="file" accept=".csv" />
    <button id="download-example">Download example</button>
    <button id="export-enriched" disabled>Export enriched CSV</button>
    <div id="status"></div>
  </div>

  <div id="diagnostics" class="box"></div>
  <div id="summary" class="box"></div>
  <div id="perClub" class="box"></div>
  <div id="mistakes" class="box"></div>

<script>
/* ---------- Helpers ---------- */
function toNum(v){ const n=parseFloat((''+v).replace(/[,\s]+/g,'')); return isNaN(n)?null:n; }
function pct(n, d){ if(d===0||d==null) return '-'; return Math.round((n/d)*1000)/10 + '%'; }
function uniq(arr){ return Array.from(new Set(arr)); }
function csvEscape(s){ if(s==null) return ''; return (''+s).replace(/"/g,'""'); }
function download(filename, text){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:'text/csv'})); a.download=filename; a.click(); }

/* ---------- Example CSV (small) ---------- */
document.getElementById('download-example').addEventListener('click', ()=>{
  const csv = `"round_id","date","course","hole","par","shot_id","club","stroke","lie","outcome","strokes","putts","shot_is_tee","fir","gir","notes"
1,2025-10-26,"Panchula",1,4,1,"Driver",1,"Tee","Fairway",4,2,true,true,false,""
1,2025-10-26,"Panchula",1,4,2,"5-iron",2,"Fairway","Approach",4,2,false,,true,""
1,2025-10-26,"Panchula",1,4,3,"Putter",3,"Green","Holed",4,2,false,,,"putt holed"
`;
  download('example_std_round.csv', csv);
});

/* ---------- CSV parsing + analysis ---------- */
let lastParsed = null;
document.getElementById('file').addEventListener('change', (e)=>{
  const f = e.target.files[0]; if(!f) return;
  document.getElementById('status').textContent = 'Parsing...';
  Papa.parse(f, {header:true, skipEmptyLines:true, dynamicTyping:false,
    complete: function(res){
      document.getElementById('status').textContent = '';
      analyzeStandardCSV(res.meta.fields, res.data);
      lastParsed = {fields: res.meta.fields, data: res.data};
      document.getElementById('export-enriched').disabled = false;
    }
  });
});

/* ---------- main analyzer tuned to your CSV columns ---------- */
function analyzeStandardCSV(headers, rows){
  const wanted = {
    round_id: headers.includes('round_id') ? 'round_id': null,
    hole: headers.includes('hole') ? 'hole' : null,
    par: headers.includes('par') ? 'par' : null,
    club: headers.includes('club') ? 'club' : null,
    stroke: headers.includes('stroke') ? 'stroke' : null,
    strokes: headers.includes('strokes') ? 'strokes' : null, // hole total
    putts: headers.includes('putts') ? 'putts' : null,
    shot_is_tee: headers.includes('shot_is_tee') ? 'shot_is_tee' : null,
    fir: headers.includes('fir') ? 'fir' : null,
    gir: headers.includes('gir') ? 'gir' : null,
    outcome: headers.includes('outcome') ? 'outcome' : null,
    lie: headers.includes('lie') ? 'lie' : null,
    penalties: headers.includes('penalties') ? 'penalties' : null
  };

  document.getElementById('diagnostics').innerHTML = `<strong>Mapped columns</strong>
    <pre>${JSON.stringify(wanted,null,2)}</pre>
    <p class="muted">If any of the main columns are missing (club, strokes, putts, outcome) results will be approximate.</p>`;

  // Normalize rows
  const data = rows.map((r, idx) => {
    return {
      __idx: idx,
      raw: r,
      round_id: wanted.round_id ? r[wanted.round_id] : '1',
      hole: wanted.hole ? r[wanted.hole] : null,
      par: wanted.par ? toNum(r[wanted.par]) : null,
      club: wanted.club ? (r[wanted.club]||'Unknown') : 'Unknown',
      stroke: wanted.stroke ? toNum(r[wanted.stroke]) : null,
      strokes: wanted.strokes ? toNum(r[wanted.strokes]) : null,
      putts: wanted.putts ? toNum(r[wanted.putts]) : null,
      shot_is_tee: wanted.shot_is_tee ? (''+r[wanted.shot_is_tee]).toLowerCase() : null,
      fir: wanted.fir ? (''+r[wanted.fir]).toLowerCase() : null,
      gir: wanted.gir ? (''+r[wanted.gir]).toLowerCase() : null,
      outcome: wanted.outcome ? (''+r[wanted.outcome]).toLowerCase() : '',
      lie: wanted.lie ? (''+r[wanted.lie]).toLowerCase() : '',
      penalties: wanted.penalties ? toNum(r[wanted.penalties]) : 0
    };
  });

  // Group by round+hole
  const holesMap = {};
  for (let s of data){
    const key = `${s.round_id}||${s.hole}`;
    if (!holesMap[key]) holesMap[key] = {round_id: s.round_id, hole: s.hole, par: s.par, shots: []};
    holesMap[key].shots.push(s);
  }
  // compute overall totals
  const holes = Object.values(holesMap);
  let totalStrokes = 0, totalHoles=0, totalPutts=0, totalFirAttempts=0, totalFirHits=0, totalGirAttempts=0, totalGirHits=0;
  let scrambleAttempts=0, scrambleSuccess=0;
  const clubAgg = {}; // club -> stats
  const mistakeCounts = {left:0,right:0,short:0,long:0,bunker:0,penalty:0,other:0};

  for (let h of holes){
    if (!h.shots.length) continue;
    totalHoles++;
    // hole strokes: try to use 'strokes' column from first shot of hole if present (export puts hole-level on every shot)
    const holeStrokes = h.shots.find(s=>s.strokes!=null && !isNaN(s.strokes))?.strokes;
    if (holeStrokes!=null) totalStrokes += holeStrokes;
    else totalStrokes += h.shots.length; // fallback
    // putts: try to find putts entry on any row
    const holePutts = h.shots.find(s=>s.putts!=null && !isNaN(s.putts))?.putts;
    if (holePutts!=null) totalPutts += holePutts;
    else {
      // fallback count of club containing 'putt'
      totalPutts += h.shots.filter(s => s.club && s.club.toLowerCase().includes('putt')).length;
    }

    // FIR/GIR flags often present on tee or hole-level
    const teeShot = h.shots[0];
    if (h.par && (h.par==4 || h.par==5)) {
      totalFirAttempts++;
      if (teeShot && teeShot.fir && (teeShot.fir.includes('true') || teeShot.fir==='1' || teeShot.fir.includes('y'))) totalFirHits++;
    }

    // GIR: check any shot in hole has gir true (or shots include 'green' outcome) on approach and par is present
    let holeGir = false;
    for (let s of h.shots){
      if (s.gir && (s.gir.includes('true') || s.gir==='1' || s.gir.includes('y'))) { holeGir = true; break; }
      if (s.outcome && s.outcome.includes('green')) { holeGir = true; break; }
    }
    if (h.par!=null) { totalGirAttempts++; if (holeGir) totalGirHits++; }

    // Scrambling: if missed GIR and hole score <= par => scramble success
    if (h.par!=null) {
      const strokesForHole = holeStrokes!=null ? holeStrokes : h.shots.length;
      if (!holeGir) { scrambleAttempts++; if (strokesForHole <= h.par) scrambleSuccess++; }
    }

    // per-shot & per-club aggregates; also compute mistakes by scanning outcome text, lie, penalties
    for (let s of h.shots){
      const club = s.club || 'Unknown';
      if (!clubAgg[club]) clubAgg[club] = {shots:0, holesWithClub:new Set(), outcomes:{}, avgHoleStrokesWhenUsed:[], penalties:0};
      const C = clubAgg[club];
      C.shots++;
      C.holesWithClub.add(`${h.round_id}||${h.hole}`);
      // add hole score to list (to compute avg hole score when this club used)
      C.avgHoleStrokesWhenUsed.push(holeStrokes!=null ? holeStrokes : h.shots.length);
      if (s.penalties) C.penalties += s.penalties;
      // outcome breakdown tokenization
      const out = s.outcome || '';
      if (!C.outcomes[out]) C.outcomes[out]=0; C.outcomes[out]++;

      // detect mistakes from outcome & lie & penalties
      if (out.includes('left')) mistakeCounts.left++;
      else if (out.includes('right')) mistakeCounts.right++;
      else if (out.includes('short')) mistakeCounts.short++;
      else if (out.includes('long')) mistakeCounts.long++;
      if (out.includes('bunker') || s.lie && s.lie.includes('bunker')) mistakeCounts.bunker++;
      if (s.penalties && s.penalties>0) mistakeCounts.penalty++;
      if (!out.includes('left') && !out.includes('right') && !out.includes('short') && !out.includes('long') && !(out.includes('bunker')|| (s.lie && s.lie.includes('bunker'))) && !(s.penalties>0)) mistakeCounts.other++;
    }
  }

  // compute summary metrics
  const scoringAvg = totalHoles ? (totalStrokes / totalHoles) : null;
  const puttingAvg = totalHoles ? (totalPutts / totalHoles) : null;
  const firPct = totalFirAttempts ? (totalFirHits / totalFirAttempts) : null;
  const girPct = totalGirAttempts ? (totalGirHits / totalGirAttempts) : null;
  const scramblePct = (scrambleAttempts? (scrambleSuccess / scrambleAttempts) : null);

  // club list with aggregated numbers
  const clubList = Object.keys(clubAgg).map(club => {
    const o = clubAgg[club];
    return {
      club,
      shots: o.shots,
      holes: o.holesWithClub.size,
      avgHoleStrokes: Math.round((o.avgHoleStrokesWhenUsed.reduce((a,b)=>a+b,0)/o.avgHoleStrokesWhenUsed.length)*100)/100,
      penalties: o.penalties,
      topOutcomes: Object.entries(o.outcomes).sort((a,b)=>b[1]-a[1]).slice(0,5)
    };
  }).sort((a,b)=>b.shots - a.shots);

  // identify problematic clubs: highest avgHoleStrokes & many shots (proxy for costly clubs)
  const problematic = clubList.filter(c=>c.shots>=5).sort((a,b)=>b.avgHoleStrokes - a.avgHoleStrokes).slice(0,6);

  // top mistake type
  const mistakeRank = Object.entries(mistakeCounts).sort((a,b)=>b[1]-a[1]);
  const topMistake = mistakeRank.length? mistakeRank[0][0] : 'none';

  // render summary
  document.getElementById('summary').innerHTML = `<strong>Round summary</strong>
    <table>
      <tr><th>Holes</th><td>${totalHoles}</td></tr>
      <tr><th>Total strokes</th><td>${totalStrokes}</td></tr>
      <tr><th>Scoring avg (strokes/hole)</th><td>${scoringAvg? Math.round(scoringAvg*100)/100 : '-'}</td></tr>
      <tr><th>Putting avg (putts/hole)</th><td>${puttingAvg? Math.round(puttingAvg*100)/100 : '-'}</td></tr>
      <tr><th>FIR % (par4/5)</th><td>${firPct!=null? pct(totalFirHits, totalFirAttempts) : '-'}</td></tr>
      <tr><th>GIR %</th><td>${girPct!=null? pct(totalGirHits, totalGirAttempts) : '-'}</td></tr>
      <tr><th>Scrambling % (when missed GIR)</th><td>${scramblePct!=null? Math.round(scramblePct*1000)/10+'%' : '-'}</td></tr>
    </table>
    <p class="muted"><strong>Important:</strong> No distance columns present → true strokes-gained requires distance/lie baseline. This analysis uses hole-level proxies and outcome text to flag problems.</p>
  `;

  // per-club table
  document.getElementById('perClub').innerHTML = `<strong>Per-club summary (top 30)</strong>
    <table><thead><tr><th>Club</th><th>Shots</th><th>Holes used</th><th>Avg hole strokes when used</th><th>Penalties</th><th>Top outcomes</th></tr></thead>
    <tbody>
      ${clubList.slice(0,30).map(c=>`<tr>
        <td>${c.club}</td>
        <td>${c.shots}</td>
        <td>${c.holes}</td>
        <td>${c.avgHoleStrokes}</td>
        <td>${c.penalties}</td>
        <td>${c.topOutcomes.map(t=>`${t[0]} (${t[1]})`).join(', ')}</td>
      </tr>`).join('')}
    </tbody></table>`;


  // mistakes summary
  document.getElementById('mistakes').innerHTML = `<strong>Mistakes & problems</strong>
    <p>Top mistake type (heuristic): <strong>${topMistake}</strong></p>
    <p>Counts: ${Object.entries(mistakeCounts).map(kv=>`${kv[0]}: ${kv[1]}`).join(' • ')}</p>
    <p><strong>Most problematic clubs (proxy — avg hole strokes when used, min 5 shots):</strong></p>
    ${problematic.length? `<ol>${problematic.map(p=>`<li>${p.club} — avg hole strokes ${p.avgHoleStrokes} over ${p.shots} shots</li>`).join('')}</ol>` : '<em>No club reached 5 shots or insufficient data.</em>'}
    <p style="margin-top:8px"><em>Want a CSV export that flags shots with the detected mistake tags? Click Export enriched CSV.</em></p>
  `;

  // save enriched data for export
  window._enriched = data.map(s=>{
    // create outcome tags array
    const tags = [];
    if (s.outcome.includes('left')) tags.push('left');
    if (s.outcome.includes('right')) tags.push('right');
    if (s.outcome.includes('short')) tags.push('short');
    if (s.outcome.includes('long')) tags.push('long');
    if (s.outcome.includes('bunker') || (s.lie && s.lie.includes('bunker'))) tags.push('bunker');
    if (s.penalties && s.penalties>0) tags.push('penalty');
    const problematicFlag = (tags.length>0) ? 'yes' : 'no';
    return Object.assign({}, s.raw, {analysis_outcomeTags: tags.join('|'), analysis_problematic: problematicFlag});
  });
}

/* ---------- Export enriched CSV ---------- */
document.getElementById('export-enriched').addEventListener('click', ()=>{
  if (!window._enriched || !window._enriched.length) return alert('No parsed data yet.');
  const rows = window._enriched;
  const fields = Object.keys(rows[0]);
  const csv = [fields.map(f=>`"${f}"`).join(',')].concat(rows.map(r=> fields.map(f=> `"${csvEscape(r[f])}"`).join(',')).join('\n'));
  download('enriched_round.csv', csv.join('\n'));
});
</script>
</body>
</html>
