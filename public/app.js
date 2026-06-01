import { toRad, distNm, bearing, angDiff } from '/src/geo.js';
import { makeSampler, expectedCycle, cycLabel } from '/src/forecast.js';
import { decodePngData, maskLand, VIEW } from '/src/landmask.js';
import { linesFromContent, parseORR } from '/src/orrParse.js';

// ---- Boats (loaded from JSON) ----
const { boats: BOATS, boatOrder: BOAT_ORDER } = await fetch('/data/boats.json').then(r => r.json());

// ---- Constants ----
const SF   = { lat: 37.60,   lon: -122.90   };
const DEST = { lat: 21.4806, lon: -157.7725 };
// Render a wider area than the land-mask coverage so Hawaii clears the left controls panel
const RVIEW = { latMin: 14, latMax: 44.5, lonMin: -175, lonMax: -113 };
const HIGH = { lat: 37, lon: -147 };
const WIND_STOPS = [[0,[43,74,90]],[8,[46,154,166]],[14,[79,208,199]],[20,[255,209,102]],[28,[255,107,94]]];
const RESOLVE_NM = 1.5, RESOLVE_MS = 60000;
const DEST_NAME = 'Kaneohe Bay';

// ---- Mutable state ----
let POLAR = BOATS.sc40.polar;
let POLAR_EFF = 1.00;
let MASK = null, LANDCANVAS = null;
let SAMPLER = null, FIELD = 'synthetic', GRID = null;
let DISP_T = 0, EPOCH0 = Math.floor(Date.now() / 1000), HORIZON_H = 192, MAXT = 384;
let result = null, origin = SF;
let CACHE = null, LIVE_OFF = false, reqSeq = 0;
let watchId = null, livePos = null, liveCog = null, liveSog = null, lastSolve = null, solving = false;

// ---- Canvas ----
const cv = document.getElementById('map'), ctx = cv.getContext('2d');
let dpr = 1, W = 0, H = 0;

// ---- Projection ----
const px    = (lat, lon) => [(lon - RVIEW.lonMin) / (RVIEW.lonMax - RVIEW.lonMin) * W,
                             (RVIEW.latMax - lat) / (RVIEW.latMax - RVIEW.latMin) * H];
const unpx  = (x, y)    => ({ lat: RVIEW.latMax - y/H*(RVIEW.latMax - RVIEW.latMin),
                               lon: RVIEW.lonMin + x/W*(RVIEW.lonMax - RVIEW.lonMin) });
const inChart = (lat, lon) => lat > RVIEW.latMin && lat < RVIEW.latMax && lon > RVIEW.lonMin && lon < RVIEW.lonMax;
const isLand  = (lat, lon) => MASK ? maskLand(MASK, lat, lon) : false;

// ---- Worker ----
const worker = new Worker('/worker.js', { type: 'module' });
let resolveCompute = null;
worker.onmessage = (e) => {
  if (e.data.type === 'result') {
    result = e.data;
    draw();
    if (resolveCompute) { resolveCompute(); resolveCompute = null; }
  } else if (e.data.type === 'error') {
    console.error('[worker]', e.data.message);
    if (resolveCompute) { resolveCompute(); resolveCompute = null; }
  }
};
function compute() {
  return new Promise(resolve => {
    resolveCompute = resolve;
    worker.postMessage({ origin, dest: DEST, polar: POLAR, polarEff: POLAR_EFF, grid: GRID });
  });
}

// ---- Synthetic environment (offline fallback for rendering) ----
function synthEnv(lat, lon) {
  const d = distNm(HIGH, { lat, lon }), brg = bearing(HIGH, { lat, lon }), twd = (brg + 270) % 360;
  const tws = Math.min(27, 27 * (1 - Math.exp(-d / 520)));
  return { tws, twd, waveHeight: 0.18*tws+0.7, wavePeriod: 5+tws/3.5, waveDir: twd, curSpeed: 0.3, curDir: 270 };
}
function getEnv(lat, lon, t) {
  return (FIELD === 'live' && SAMPLER) ? SAMPLER(lat, lon, t || 0) : synthEnv(lat, lon);
}

// ---- Colors ----
const lerp = (a, b, t) => a + (b - a) * t;
function windColor(s) {
  let lo = WIND_STOPS[0], hi = WIND_STOPS[WIND_STOPS.length - 1];
  for (let i = 0; i < WIND_STOPS.length - 1; i++)
    if (s >= WIND_STOPS[i][0] && s <= WIND_STOPS[i+1][0]) { lo = WIND_STOPS[i]; hi = WIND_STOPS[i+1]; break; }
  const t = (s - lo[0]) / (hi[0] - lo[0] || 1);
  const c = lo[1].map((v, i) => Math.round(lerp(v, hi[1][i], Math.max(0, Math.min(1, t)))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function waveColor(h) {
  const t = Math.max(0, Math.min(1, h / 5));
  return `rgba(${Math.round(lerp(40,255,t))},${Math.round(lerp(90,150,t))},${Math.round(lerp(150,90,t))},0.16)`;
}

// ---- Drawing ----
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1); W = window.innerWidth; H = window.innerHeight;
  cv.width = W*dpr; cv.height = H*dpr; cv.style.width = W+'px'; cv.style.height = H+'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw();
}
function drawOcean() {
  const g = ctx.createRadialGradient(W*0.5, H*0.42, 80, W*0.5, H*0.5, Math.max(W,H)*0.75);
  g.addColorStop(0, '#0c2230'); g.addColorStop(1, '#061019'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
function drawLand() {
  if (!LANDCANVAS) return;
  // Land mask PNG covers VIEW; project it into the wider RVIEW canvas
  const [lx, ty] = px(VIEW.latMax, VIEW.lonMin);
  const [rx, by] = px(VIEW.latMin, VIEW.lonMax);
  ctx.drawImage(LANDCANVAS, lx, ty, rx - lx, by - ty);
  // California/Baja continues east of the mask — fill to the screen edge
  ctx.fillStyle = 'rgba(28,40,34,0.95)';
  ctx.fillRect(rx, 0, W - rx, H);
}
function drawGraticule() {
  ctx.strokeStyle = 'rgba(86,152,168,0.14)'; ctx.fillStyle = '#4a7d8a';
  ctx.lineWidth = 1; ctx.font = "10px 'IBM Plex Mono'";
  for (let lat = 20; lat <= 40; lat += 5) {
    const [, y] = px(lat, VIEW.lonMin);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(lat+'°N', 6, y-4);
  }
  for (let lon = -165; lon <= -120; lon += 5) {
    const [x] = px(VIEW.latMin, lon);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.fillText(Math.abs(lon)+'°W', x+4, H-8);
  }
}
function arrow(x, y, dirToward, len, color) {
  const dx = Math.sin(toRad(dirToward)), dy = -Math.cos(toRad(dirToward));
  const ex = x+dx*len, ey = y+dy*len;
  ctx.strokeStyle = color; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(x-dx*len*0.3, y-dy*len*0.3); ctx.lineTo(ex, ey); ctx.stroke();
  const ah = Math.max(3, len*0.34), pa = toRad(dirToward);
  ctx.beginPath(); ctx.moveTo(ex, ey);
  ctx.lineTo(ex-Math.sin(pa-0.4)*ah, ey+Math.cos(pa-0.4)*ah); ctx.moveTo(ex, ey);
  ctx.lineTo(ex-Math.sin(pa+0.4)*ah, ey+Math.cos(pa+0.4)*ah); ctx.stroke();
}
function drawWaves() {
  const step = 1.4;
  for (let lat = RVIEW.latMin; lat < RVIEW.latMax; lat += step)
    for (let lon = RVIEW.lonMin; lon < RVIEW.lonMax; lon += step) {
      const e = getEnv(lat+step/2, lon+step/2, DISP_T);
      const [x,y] = px(lat, lon), [x2,y2] = px(lat-step, lon+step);
      ctx.fillStyle = waveColor(e.waveHeight); ctx.fillRect(x, y, x2-x, y2-y);
    }
}
function drawWind() {
  const step = 1.55;
  for (let lat = RVIEW.latMin+0.4; lat < RVIEW.latMax; lat += step)
    for (let lon = RVIEW.lonMin+0.4; lon < RVIEW.lonMax; lon += step) {
      const e = getEnv(lat, lon, DISP_T); const [x,y] = px(lat, lon);
      const len = 4 + Math.min(24, e.tws*0.95); arrow(x, y, (e.twd+180)%360, len, windColor(e.tws));
    }
}
function segOnLand(a, b) {
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i/n;
    if (isLand(a.lat+(b.lat-a.lat)*t, a.lon+(b.lon-a.lon)*t)) return true;
  }
  return false;
}
function nearLand(lat, lon) {
  const d = 0.07;
  return isLand(lat,lon)||isLand(lat+d,lon)||isLand(lat-d,lon)||isLand(lat,lon+d)||isLand(lat,lon-d)
    ||isLand(lat+d,lon+d)||isLand(lat-d,lon-d)||isLand(lat+d,lon-d)||isLand(lat-d,lon+d);
}
function drawIsochrones(start) {
  if (!result) return;
  result.isochrones.forEach((front, i) => {
    if (front.length < 2) return;
    const pts = [...front].sort((a, b) => bearing(start, a) - bearing(start, b));
    const major = i % 8 === 0;
    ctx.strokeStyle = major ? 'rgba(63,205,224,0.55)' : 'rgba(63,205,224,0.16)';
    ctx.lineWidth = major ? 1.3 : 0.8;
    ctx.beginPath();
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j-1], b = pts[j];
      if (nearLand(a.lat,a.lon) || nearLand(b.lat,b.lon) || segOnLand(a,b)) continue;
      const [x1,y1] = px(a.lat,a.lon), [x2,y2] = px(b.lat,b.lon);
      ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
    }
    ctx.stroke();
  });
}
function drawTrack() {
  if (!result || !result.track.length) return;
  const tr = result.track;
  let splitIdx = tr.findIndex(p => p.t > HORIZON_H); if (splitIdx < 0) splitIdx = tr.length;
  ctx.lineJoin = 'round'; ctx.shadowColor = 'rgba(255,177,59,0.55)'; ctx.shadowBlur = 12;
  ctx.strokeStyle = '#ffb13b'; ctx.lineWidth = 2.6; ctx.beginPath();
  tr.slice(0, splitIdx).forEach((p, j) => { const [x,y] = px(p.lat,p.lon); j ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.stroke();
  if (splitIdx < tr.length) {
    ctx.setLineDash([5,5]); ctx.shadowBlur = 6; ctx.beginPath();
    tr.slice(splitIdx-1).forEach((p, j) => { const [x,y] = px(p.lat,p.lon); j ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.shadowBlur = 0;
  if (splitIdx < tr.length) {
    const p = tr[splitIdx]; const [x,y] = px(p.lat,p.lon);
    ctx.strokeStyle = '#ffb13b'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x,y,6,0,7); ctx.stroke();
    ctx.fillStyle = '#ffb13b'; ctx.font = "9px 'IBM Plex Mono'"; ctx.fillText('WAVE HORIZON · DAY 8', x+10, y+3);
  }
}
function gybes(tr) {
  const g = []; if (tr.length < 3) return g;
  const rel = [];
  for (let s = 0; s < tr.length - 1; s++) {
    const h = bearing(tr[s], tr[s+1]), e = getEnv(tr[s].lat, tr[s].lon);
    rel.push(((e.twd - h + 540) % 360) - 180);
  }
  for (let s = 1; s < rel.length; s++)
    if (Math.sign(rel[s-1]) !== Math.sign(rel[s]) && Math.min(Math.abs(rel[s-1]), Math.abs(rel[s])) > 90)
      g.push(tr[s]);
  return g;
}
function drawGybes() {
  if (!result) return;
  ctx.lineWidth = 1.4;
  gybes(result.track).forEach(p => {
    const [x,y] = px(p.lat,p.lon);
    ctx.fillStyle = 'rgba(8,22,31,0.9)'; ctx.strokeStyle = 'rgba(255,209,102,0.9)';
    ctx.beginPath(); ctx.moveTo(x,y-5); ctx.lineTo(x+5,y); ctx.lineTo(x,y+5); ctx.lineTo(x-5,y); ctx.closePath();
    ctx.fill(); ctx.stroke();
  });
}
// Three sail-plan buckets based on sailFor() output — broad reach and running
// are both 'kite' so no marker fires between them.
function sailCat(twa, tws) {
  if (sailFor(twa, tws).includes('Spinnaker')) return 'kite';
  return twa < 90 ? 'upwind' : 'reach';
}
function drawSailChanges() {
  if (!result || result.track.length < 2) return;
  const tr = result.track;
  let prev = null;
  ctx.lineWidth = 1.3;
  for (let i = 1; i < tr.length - 1; i++) {
    const h = bearing(tr[i - 1], tr[i]);
    const e = getEnv(tr[i].lat, tr[i].lon, tr[i].t);
    const twa = Math.abs(((e.twd - h + 540) % 360) - 180);
    const cat = sailCat(twa, e.tws);
    if (prev !== null && cat !== prev) {
      const [x, y] = px(tr[i].lat, tr[i].lon);
      ctx.fillStyle = 'rgba(8,22,31,0.92)';
      ctx.strokeStyle = 'rgba(190,220,235,0.85)';
      if (cat === 'upwind') {
        // Triangle — upwind (Main + Genoa)
        ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5.5, y + 4); ctx.lineTo(x - 5.5, y + 4); ctx.closePath();
        ctx.fill(); ctx.stroke();
      } else if (cat === 'reach') {
        // Horizontal bar — reaching (Main + Genoa/Jib, no kite)
        ctx.beginPath(); ctx.rect(x - 6, y - 2.5, 12, 5);
        ctx.fill(); ctx.stroke();
      } else {
        // Circle — kite up (Spinnaker, any angle)
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
    prev = cat;
  }
}
function marker(p, color, r) {
  const [x,y] = px(p.lat,p.lon); ctx.fillStyle = color; ctx.strokeStyle = '#061019'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill(); ctx.stroke();
}
function label(p, text, color, dx) {
  const [x,y] = px(p.lat,p.lon); ctx.fillStyle = color; ctx.font = "600 12px 'Saira'";
  ctx.fillText(text, x+(dx||9), y-9);
}
function drawMarkers() {
  const [hx,hy] = px(DEST.lat,DEST.lon); ctx.strokeStyle = '#ff6b5e'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(hx,hy,7,0,7); ctx.moveTo(hx-11,hy); ctx.lineTo(hx+11,hy); ctx.moveTo(hx,hy-11); ctx.lineTo(hx,hy+11); ctx.stroke();
  label(DEST, 'KANEOHE BAY', '#ff6b5e');
  if (!livePos) { marker(origin, '#5fe39a', 5); label(origin, origin === SF ? 'SAN FRANCISCO' : 'POSITION', '#5fe39a'); }
}
function draw() {
  drawOcean(); drawGraticule();
  if (document.getElementById('t-wave').checked) drawWaves();
  if (document.getElementById('t-wind').checked) drawWind();
  if (document.getElementById('t-land').checked) drawLand();
  if (document.getElementById('t-iso').checked) drawIsochrones(origin);
  if (document.getElementById('t-track').checked) { drawTrack(); drawGybes(); drawSailChanges(); }
  drawMarkers(); telemetry(); if (livePos) { drawBoatHeading(); placeBoatDot(); }
}

// ---- Telemetry ----
function sailedNm(tr) { let s = 0; for (let i = 1; i < tr.length; i++) s += distNm(tr[i-1], tr[i]); return s; }
function fmtDur(h) { const d = Math.floor(h/24); return `${d}d ${Math.round(h-d*24)}h`; }
function telemetry() {
  const el = document.getElementById('telemetry'); if (!result) { el.innerHTML = ''; return; }
  const gc = distNm(origin, DEST), sailed = sailedNm(result.track);
  el.innerHTML = `<div class="row"><span class="k">PASSAGE TIME</span></div><div class="big">${fmtDur(result.hours)}</div>`
    + `<div class="row"><span class="k">great-circle</span><span class="v">${Math.round(gc)} nm</span></div>`
    + `<div class="row"><span class="k">sailed</span><span class="v">${Math.round(sailed)} nm</span></div>`
    + `<div class="row"><span class="k">avg SOG</span><span class="v">${(sailed/result.hours).toFixed(1)} kt</span></div>`
    + `<div class="row"><span class="k">extra distance</span><span class="v">+${Math.round((sailed/gc-1)*100)}%</span></div>`
    + `<div class="row"><span class="k">gybes</span><span class="v">${gybes(result.track).length}</span></div>`;
}
function sailFor(twa, tws) {
  if (twa < 42) return 'Pinching — no drive';
  if (twa < 70) return 'Main + Genoa — close-hauled';
  if (twa < 90) return 'Main + Genoa — close reach';
  if (twa < 110) return tws > 22 ? 'Main + Jib — beam reach' : 'Main + Genoa — beam reach';
  if (twa < 150) return tws > 24 ? 'Main + poled jib — heavy air' : 'Spinnaker (sym) — broad reach';
  return tws > 24 ? 'Main + poled jib — heavy air' : 'Spinnaker (sym) — running deep';
}
function nearestOnTrack(mx, my) {
  if (!result || result.track.length < 2) return null;
  const tr = result.track; let best = null;
  for (let i = 0; i < tr.length - 1; i++) {
    const [x1,y1] = px(tr[i].lat,tr[i].lon), [x2,y2] = px(tr[i+1].lat,tr[i+1].lon);
    const dx = x2-x1, dy = y2-y1, L2 = dx*dx+dy*dy||1;
    const t = Math.max(0, Math.min(1, ((mx-x1)*dx+(my-y1)*dy)/L2));
    const qx = x1+dx*t, qy = y1+dy*t, d = Math.hypot(mx-qx, my-qy);
    if (!best || d < best.d) best = { d, x:qx, y:qy,
      lat: tr[i].lat+(tr[i+1].lat-tr[i].lat)*t, lon: tr[i].lon+(tr[i+1].lon-tr[i].lon)*t,
      heading: bearing(tr[i], tr[i+1]), t: tr[i].t+(tr[i+1].t-tr[i].t)*t };
  }
  return best;
}

// ---- Cursor interaction ----
const cursorEl = document.getElementById('cursor'), routedot = document.getElementById('routedot');
cv.addEventListener('mousemove', ev => {
  const near = document.getElementById('t-track').checked ? nearestOnTrack(ev.clientX, ev.clientY) : null;
  cursorEl.style.display = 'block'; cursorEl.style.left = (ev.clientX+14)+'px'; cursorEl.style.top = (ev.clientY+14)+'px';
  if (near && near.d < 14) {
    const e = getEnv(near.lat, near.lon, near.t), twa = angDiff(e.twd, near.heading);
    const tack = (((e.twd - near.heading + 540) % 360) - 180) > 0 ? 'STBD' : 'PORT';
    routedot.style.display = 'block'; routedot.style.left = near.x+'px'; routedot.style.top = near.y+'px';
    cursorEl.innerHTML = `<span class="lbl">heading</span> ${Math.round(near.heading)}°  <span class="lbl">tack</span> ${tack}<br>`
      + `<span class="lbl">TWA</span> ${Math.round(twa)}°  <span class="lbl">wind</span> ${Math.round(e.tws)} kt<br>`
      + `<span class="lbl">sail</span> ${sailFor(twa, e.tws)}<br>`
      + `<span class="lbl">ETA</span> +${fmtDur(near.t)}`;
  } else {
    routedot.style.display = 'none';
    const p = unpx(ev.clientX, ev.clientY), e = getEnv(p.lat, p.lon, DISP_T);
    cursorEl.innerHTML = `<span class="lbl">pos </span>${p.lat.toFixed(1)}°N ${Math.abs(p.lon).toFixed(1)}°W<br>`
      + `<span class="lbl">wind</span> ${Math.round(e.tws)} kt from ${Math.round(e.twd)}°<br>`
      + `<span class="lbl">sea </span> Hs ${e.waveHeight.toFixed(1)} m @ ${e.wavePeriod.toFixed(0)} s`;
  }
});
cv.addEventListener('mouseleave', () => { cursorEl.style.display = 'none'; routedot.style.display = 'none'; });
cv.addEventListener('click', ev => {
  const p = unpx(ev.clientX, ev.clientY);
  if (distNm(p, DEST) < 60) return;
  origin = { lat: +p.lat.toFixed(2), lon: +p.lon.toFixed(2) }; replan();
});

// ---- Controls wiring ----
document.querySelectorAll('#controls input').forEach(c => c.addEventListener('change', draw));
document.getElementById('reset').addEventListener('click', () => { origin = SF; replan(); });
document.getElementById('legend-bar').style.background =
  `linear-gradient(90deg,${WIND_STOPS.map(s => windColor(s[0])).join(',')})`;
window.addEventListener('resize', resize);

// ---- Forecast pipeline ----
function applyEnv(env) {
  SAMPLER = makeSampler(env); FIELD = 'live'; GRID = env;
  EPOCH0 = env.epoch0; HORIZON_H = env.marineHorizonHours; MAXT = env.times[env.times.length - 1];
}
function setStatus(t, c) { const s = document.getElementById('status'); s.textContent = t; s.className = 'status '+(c||''); }
function updateTimeLabel() {
  const d = Math.floor(DISP_T/24), h = Math.round(DISP_T - d*24);
  const when = new Date((EPOCH0 + DISP_T*3600)*1000).toISOString().slice(5,16).replace('T',' ');
  document.getElementById('timelabel').textContent = '+'+d+'d '+h+'h · '+when+'Z';
}
function setupSlider(live) {
  const w = document.getElementById('timewrap'); w.style.display = live ? 'block' : 'none';
  if (!live) return;
  const s = document.getElementById('timeslider'); s.max = Math.floor(MAXT); s.step = 3; s.value = 0; DISP_T = 0; updateTimeLabel();
}
document.getElementById('timeslider').addEventListener('input', e => { DISP_T = +e.target.value; updateTimeLabel(); draw(); });
document.getElementById('effslider').addEventListener('input', e => { document.getElementById('efflabel').textContent = e.target.value+'%'; });
document.getElementById('effslider').addEventListener('change', e => { POLAR_EFF = +e.target.value / 100; compute(); });

async function replan() {
  const seq = ++reqSeq, cyc = expectedCycle();
  if (CACHE && CACHE.cycle === cyc) {
    applyEnv(CACHE.env);
    setStatus('◉ live · cached · GFS '+cycLabel(cyc)+' (no refetch)', 'live');
    setupSlider(true); await compute(); return;
  }
  if (LIVE_OFF) {
    FIELD = 'synthetic'; setStatus('◉ demo · synthetic field (live unavailable)', 'demo');
    setupSlider(false); await compute(); return;
  }
  setStatus('◌ fetching live forecast…', 'load');
  let env = null, hardFail = false;
  try {
    const r = await fetch('/api/forecast');
    if (!r.ok) throw new Error('HTTP '+r.status);
    env = await r.json();
  } catch { hardFail = true; }
  if (seq !== reqSeq) return;
  if (env) {
    CACHE = { cycle: cyc, env }; applyEnv(env);
    setStatus('◉ live · GFS + marine · '+cycLabel(cyc), 'live'); setupSlider(true);
  } else if (hardFail) {
    if (SAMPLER) { setStatus('◉ live · last forecast (refetch failed)', 'live'); }
    else { FIELD = 'synthetic'; LIVE_OFF = true; setStatus('◉ demo · synthetic field (live unavailable)', 'demo'); setupSlider(false); }
  }
  await compute();
}

// ---- Boat selector + ORR cert upload ----
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
function boatSub(id) { return (BOATS[id].name + ' · ' + BOATS[id].meta).toUpperCase(); }
function populateBoatSelect() {
  const sel = document.getElementById('boat'); sel.innerHTML = '';
  BOAT_ORDER.forEach(id => { const o = document.createElement('option'); o.value = id; o.textContent = BOATS[id].name; sel.appendChild(o); });
}
function setBoat(id) {
  if (!BOATS[id]) return;
  POLAR = BOATS[id].polar; document.getElementById('boat').value = id;
  document.getElementById('boatsub').textContent = boatSub(id); compute();
}
function setupBoats() {
  populateBoatSelect(); document.getElementById('boat').value = 'sc40';
  document.getElementById('boatsub').textContent = boatSub('sc40');
  document.getElementById('boat').addEventListener('change', e => setBoat(e.target.value));
  document.getElementById('cert').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadCert(f); e.target.value = ''; });
}
async function loadCert(file) {
  const msg = document.getElementById('certmsg');
  if (!window.pdfjsLib) { msg.textContent = 'PDF reader did not load (offline?). Presets still work.'; msg.className = 'certmsg err'; return; }
  msg.textContent = 'Reading '+file.name+'…'; msg.className = 'certmsg';
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p); const tc = await pg.getTextContent();
      lines = lines.concat(linesFromContent(tc.items));
    }
    const polar = parseORR(lines);
    const id = 'cert'+Object.keys(BOATS).length;
    BOATS[id] = { name: file.name.replace(/\.pdf$/i,'').slice(0,26)||'Uploaded cert', meta: 'uploaded ORR cert', loa: null, polar };
    BOAT_ORDER.push(id); populateBoatSelect(); setBoat(id);
    msg.textContent = '✓ polar loaded · '+polar.tws.length+' wind speeds × '+polar.twa.length+' angles';
    msg.className = 'certmsg ok';
  } catch (err) { msg.textContent = '✗ '+err.message; msg.className = 'certmsg err'; }
}

// ---- Geolocation: one-shot ----
function dm(v, pos, neg) { const h = v>=0?pos:neg, a = Math.abs(v), d = Math.floor(a), m = (a-d)*60; return d+'°'+m.toFixed(1)+"'"+h; }
function geoModal(html) { document.getElementById('geo-body').innerHTML = html; document.getElementById('geo-modal').hidden = false; }
function closeGeo() { document.getElementById('geo-modal').hidden = true; }
function geoRow(lbl, val, big) { return '<div class="geo-row"><span class="lbl">'+lbl+'</span><span class="val'+(big?' big':'')+'">'+val+'</span></div>'; }
function posRows(lat, lon) {
  return geoRow('Latitude',dm(lat,'N','S'))+geoRow('Longitude',dm(lon,'E','W'))
    +geoRow('Decimal',lat.toFixed(4)+', '+lon.toFixed(4))+geoRow('Destination',DEST_NAME);
}
function boatName() { return BOATS[document.getElementById('boat').value].name; }
function routeFromLocation() {
  if (!navigator.geolocation) { geoModal('<div class="geo-note err">This browser can\'t share a location.</div>'); return; }
  geoModal('<div class="geo-note wait">◌ Requesting your location… allow access when your browser asks.</div>');
  navigator.geolocation.getCurrentPosition(async function(p) {
    const lat = p.coords.latitude, lon = p.coords.longitude;
    const direct = Math.round(bearing({lat,lon}, DEST)), dist = Math.round(distNm({lat,lon}, DEST));
    const onWater = inChart(lat,lon) && !isLand(lat,lon);
    if (!onWater) {
      geoModal(posRows(lat,lon)+geoRow('Bearing to dest',direct+'°T',true)+geoRow('Distance',dist.toLocaleString()+' nm')
        +'<div class="geo-note warn">You\'re outside the charted SF–Hawaii corridor — showing the direct bearing only; the route is unchanged.</div>');
      return;
    }
    geoModal(posRows(lat,lon)+'<div class="geo-note wait">◌ Computing the optimal route for the '+boatName()+'…</div>');
    origin = { lat: +lat.toFixed(2), lon: +lon.toFixed(2) };
    await replan();
    if (result && result.reached && result.track.length >= 2) {
      const opt = Math.round(bearing(result.track[0], result.track[1]));
      const eta = (result.hours/24).toFixed(1);
      const off = Math.round(((opt-direct+540)%360)-180);
      geoModal(posRows(lat,lon)+geoRow('Optimal heading',opt+'°T',true)+geoRow('Direct bearing',direct+'°T')
        +geoRow('Distance',dist.toLocaleString()+' nm')+geoRow('ETA',eta+' days')
        +'<div class="geo-note ok">▸ Routed for the '+boatName()+'. Optimal heading is '
          +(Math.abs(off)>=1?(Math.abs(off)+'° '+(off>0?'right':'left')+' of the direct line'):'on the direct line')
          +' — close this to see the track.</div>');
    } else {
      geoModal(posRows(lat,lon)+geoRow('Bearing to dest',direct+'°T',true)+geoRow('Distance',dist.toLocaleString()+' nm')
        +'<div class="geo-note warn">Couldn\'t compute a full route from here — showing the direct bearing.</div>');
    }
  }, function(err) {
    const m = {1:'Location permission was denied. Enable it in your browser\'s site settings, then try again.',
               2:'Your position is unavailable right now. With a clear view of the sky, try again.',
               3:'The location request timed out. Please try again.'};
    geoModal('<div class="geo-note err">'+(m[err.code]||'Could not get your location.')+'</div>');
  }, {enableHighAccuracy:true, timeout:10000, maximumAge:60000});
}
document.getElementById('geo').addEventListener('click', routeFromLocation);
document.getElementById('geo-close').addEventListener('click', closeGeo);
document.getElementById('geo-modal').addEventListener('click', function(e) { if (e.target.id === 'geo-modal') closeGeo(); });

function regattamanUrl() {
  const d = new Date(), iso = d.toISOString().slice(0, 10), yr = d.getUTCFullYear();
  return 'https://regattaman.com/cert_list.php?lType=effD&effDate=' + iso +
         '&crule=ORR&yr=' + yr + '&goback=/certificate_page.php?cp_tab=1';
}
function openCert() {
  document.getElementById('cert-list-link').href = regattamanUrl();
  document.getElementById('cert-modal').hidden = false;
}
function closeCert() { document.getElementById('cert-modal').hidden = true; }

document.getElementById('cert-help-link').addEventListener('click', e => { e.preventDefault(); openCert(); });
document.getElementById('cert-close').addEventListener('click', closeCert);
document.getElementById('cert-modal').addEventListener('click', e => { if (e.target.id === 'cert-modal') closeCert(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { closeGeo(); closeCert(); } });

// ---- Geolocation: continuous tracking ----
function optimalHeadingDeg() {
  return (result && result.reached && result.track.length >= 2) ? Math.round(bearing(result.track[0], result.track[1])) : null;
}
function placeBoatDot() {
  const el = document.getElementById('boatdot'); if (!livePos) { el.hidden = true; return; }
  const a = px(livePos.lat, livePos.lon); el.style.left = a[0]+'px'; el.style.top = a[1]+'px'; el.hidden = false;
}
function drawBoatHeading() {
  const opt = optimalHeadingDeg(); if (opt == null) return;
  const a = px(livePos.lat, livePos.lon); arrow(a[0], a[1], opt, 26, '#3fcde0');
}
function hudErr(msg) { document.getElementById('livehud').hidden = false; document.getElementById('hud-body').innerHTML = '<div class="hnote err">'+msg+'</div>'; }
function updateHud(note, noteCls) {
  if (!livePos) return;
  const opt = optimalHeadingDeg(), dist = Math.round(distNm(livePos, DEST));
  const cog = (liveCog != null && !Number.isNaN(liveCog)) ? Math.round(liveCog)+'°' : '—';
  const sog = (liveSog != null && !Number.isNaN(liveSog)) ? (liveSog*1.943844).toFixed(1)+' kt' : '—';
  const eta = (result && result.reached) ? (result.hours/24).toFixed(1)+' d' : '—';
  document.getElementById('hud-body').innerHTML =
    '<div class="hrow"><span class="k">optimal hdg</span></div>'
    +'<div class="hbig">'+(opt != null ? opt+'°T' : '—')+'</div>'
    +'<div class="hrow"><span class="k">position</span><span class="v">'+dm(livePos.lat,'N','S')+'</span></div>'
    +'<div class="hrow"><span class="k"></span><span class="v">'+dm(livePos.lon,'E','W')+'</span></div>'
    +'<div class="hrow"><span class="k">COG · SOG</span><span class="v">'+cog+' · '+sog+'</span></div>'
    +'<div class="hrow"><span class="k">to '+DEST_NAME+'</span><span class="v">'+dist.toLocaleString()+' nm</span></div>'
    +'<div class="hrow"><span class="k">ETA</span><span class="v">'+eta+'</span></div>'
    +(note ? '<div class="hnote '+(noteCls||'')+'">'+note+'</div>' : '');
}
async function maybeResolve() {
  if (solving) return;
  const moved = lastSolve ? distNm(livePos, lastSolve) : Infinity;
  const aged  = lastSolve ? (Date.now() - lastSolve.t) : Infinity;
  if (!(moved >= RESOLVE_NM || aged >= RESOLVE_MS)) return;
  if (!inChart(livePos.lat, livePos.lon) || isLand(livePos.lat, livePos.lon)) return;
  solving = true; origin = { lat: +livePos.lat.toFixed(2), lon: +livePos.lon.toFixed(2) };
  lastSolve = { lat: livePos.lat, lon: livePos.lon, t: Date.now() };
  await replan(); solving = false; updateHud();
}
function onFix(p) {
  livePos = { lat: p.coords.latitude, lon: p.coords.longitude };
  liveCog = p.coords.heading; liveSog = p.coords.speed;
  placeBoatDot(); draw();
  const off = !inChart(livePos.lat, livePos.lon) || isLand(livePos.lat, livePos.lon);
  updateHud(off ? 'Outside the charted SF–Hawaii corridor — marker only.' : '', off ? 'err' : '');
  maybeResolve();
}
function onWatchErr(err) {
  const m = {1:'Permission denied — enable location in your browser\'s site settings.',
             2:'Position unavailable right now.', 3:'Location request timed out; still trying…'};
  hudErr(m[err.code] || 'Could not get your location.');
  if (err.code === 1) stopTracking();
}
function startTracking() {
  if (!navigator.geolocation) { hudErr('This browser can\'t share a location.'); return; }
  document.getElementById('livehud').hidden = false;
  document.getElementById('hud-body').innerHTML = '<div class="hnote">◌ Acquiring GPS… allow access when your browser asks.</div>';
  const btn = document.getElementById('track'); btn.classList.add('active'); btn.textContent = '■ Stop tracking';
  lastSolve = null; solving = false;
  watchId = navigator.geolocation.watchPosition(onFix, onWatchErr, {enableHighAccuracy:true, maximumAge:2000, timeout:15000});
}
function stopTracking() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  livePos = null; liveCog = liveSog = null;
  document.getElementById('boatdot').hidden = true; document.getElementById('livehud').hidden = true;
  const btn = document.getElementById('track'); btn.classList.remove('active'); btn.textContent = '▶ Track my position';
  draw();
}
document.getElementById('track').addEventListener('click', function() { watchId == null ? startTracking() : stopTracking(); });

// ---- Land mask load ----
async function loadMask() {
  try {
    const resp = await fetch('/data/corridor-landmask.png');
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const nx = bitmap.width, ny = bitmap.height;
    const oc = document.createElement('canvas');
    oc.width = nx; oc.height = ny;
    oc.getContext('2d').drawImage(bitmap, 0, 0);
    const rgba = oc.getContext('2d').getImageData(0, 0, nx, ny).data;
    MASK = decodePngData(nx, ny, rgba);
    const lc = document.createElement('canvas');
    lc.width = nx; lc.height = ny;
    const lctx = lc.getContext('2d'), tint = lctx.createImageData(nx, ny);
    for (let i = 0; i < nx * ny; i++) {
      const land = rgba[i*4] > 127; const o = i*4;
      tint.data[o] = 28; tint.data[o+1] = 40; tint.data[o+2] = 34; tint.data[o+3] = land ? 242 : 0;
    }
    lctx.putImageData(tint, 0, 0); LANDCANVAS = lc;
  } catch (e) { console.warn('[app] land mask unavailable:', e.message); }
}

// ---- Draggable panels ----
function makeDraggable(el) {
  let dx = 0, dy = 0;
  function applyDrag(cx, cy, sx, sy) {
    dx = cx - sx; dy = cy - sy;
    el.style.transform = `translate(${dx}px,${dy}px)`;
  }
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX - dx, sy = e.clientY - dy;
    el.style.cursor = 'grabbing';
    const onMove = e => applyDrag(e.clientX, e.clientY, sx, sy);
    const onUp = () => { el.style.cursor = 'grab'; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  el.addEventListener('touchstart', e => {
    const t = e.touches[0], sx = t.clientX - dx, sy = t.clientY - dy;
    const onMove = e => { const t = e.touches[0]; applyDrag(t.clientX, t.clientY, sx, sy); };
    const onEnd = () => { el.removeEventListener('touchmove', onMove); el.removeEventListener('touchend', onEnd); };
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
  }, { passive: true });
}
makeDraggable(document.getElementById('telemetry'));

// ---- Init ----
setupBoats();
resize();
await loadMask();
resize();
await replan();
