import { toRad, distNm, bearing, angDiff } from '/src/geo.js';
import { makeSampler, expectedCycle, cycLabel } from '/src/forecast.js';
import { decodePngData, maskLand, VIEW } from '/src/landmask.js';
import { linesFromContent, parseORR } from '/src/orrParse.js';

function fmtPacific(epochMs) {
  const d = new Date(epochMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false, timeZoneName: 'short'
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

// ---- Boats + island polygons (loaded from JSON) ----
const [{ boats: BOATS, boatOrder: BOAT_ORDER }, ISLANDS] = await Promise.all([
  fetch('/data/boats.json').then(r => r.json()),
  fetch('/islands.json').then(r => r.json()).catch(() => []),
]);

// ---- Constants ----
const SF         = { lat: 37.80,    lon: -122.60    }; // Pac Cup start — open Pacific, 5 nm WSW of Golden Gate
const SAN_PEDRO  = { lat: 33.6917,  lon: -118.2917  }; // Transpac start line

const ROUTES = {
  paccup:   { origin: SF,        dest: { lat: 21.4806, lon: -157.7725 },    destLabel: 'KANEOHE BAY',  destName: 'Kaneohe Bay',  resetLabel: 'Reset to San Francisco' },
  transpac: { origin: SAN_PEDRO, dest: { lat: 21.245417, lon: -157.816694 },
              // Black Point headland is land in GSHHG — route to open water 3 nm offshore instead
              routeDest: { lat: 21.19, lon: -157.83 },
              destLabel: 'DIAMOND HEAD', destName: 'Diamond Head', resetLabel: 'Reset to San Pedro' },
};
let DEST       = ROUTES.paccup.dest;
let ROUTE_DEST = ROUTES.paccup.routeDest ?? ROUTES.paccup.dest;
let DEST_LABEL = ROUTES.paccup.destLabel;
// Render a wider area than the land-mask coverage so Hawaii clears the left controls panel
const BASE_RVIEW = { latMin: 14, latMax: 44.5, lonMin: -175, lonMax: -108 };
const RVIEW = { ...BASE_RVIEW }; // mutated in-place by zoom/pan

// Approximate Pacific coastline, Oregon → Cabo San Lucas, traced N→S.
// Points east of RVIEW.lonMax are clamped to the right screen edge when drawn.
const CALIFORNIA_COAST = [
  [44.5, -124.2], // Oregon coast at map top edge
  [42.0, -124.5], // Cape Ferrelo / OR–CA border
  [40.4, -124.4], // Cape Mendocino
  [38.9, -123.7], // Fort Bragg
  [38.3, -123.1], // Bodega Bay
  [38.0, -122.9], // Point Reyes
  [37.9, -122.7], // Marin Headlands / Golden Gate
  [37.8, -122.5], // San Francisco
  [37.5, -122.5], // Pacifica
  [37.0, -122.0], // Santa Cruz
  [36.6, -121.9], // Monterey
  [36.2, -121.8], // Point Sur
  [35.7, -121.3], // Morro Bay
  [35.1, -120.9], // Point San Luis
  [34.5, -120.5], // Point Conception
  [34.4, -119.7], // Santa Barbara
  [34.2, -119.2], // Ventura / Port Hueneme
  [34.0, -118.5], // Santa Monica
  [33.95, -118.45], // El Segundo / Hermosa Beach
  [33.84, -118.40], // Redondo Beach
  [33.74, -118.41], // Point Vicente (Palos Verdes tip)
  [33.70, -118.29], // Point Fermin / San Pedro
  [33.76, -118.19], // Long Beach
  [33.65, -117.98], // Huntington Beach
  [33.4, -117.8], // Newport Beach
  [33.2, -117.5], // San Clemente
  [32.7, -117.2], // San Diego
  [32.5, -117.1], // Tijuana
  [31.9, -116.7], // Ensenada
  [30.6, -116.1], // San Quintín
  [30.0, -115.8], // Punta Baja
  [27.9, -115.1], // Punta Eugenia
  [26.8, -113.8], // mid-Baja
  [24.5, -111.5], // southern Baja (east of screen, clamped)
  [23.0, -109.9], // Cabo San Lucas (clamped)
  [14.0, -108.0], // southern boundary (clamped)
];
const HIGH = { lat: 37, lon: -147 };
const WIND_STOPS = [[0,[43,74,90]],[8,[46,154,166]],[14,[79,208,199]],[20,[255,209,102]],[28,[255,107,94]]];
const RESOLVE_NM = 1.5, RESOLVE_MS = 60000;
let DEST_NAME = ROUTES.paccup.destName;

// ---- Mutable state ----
let activeRoute = 'paccup';
let POLAR = BOATS.sc40.polar;
let POLAR_EFF = 1.00;
let ASYM = false;
let MASK = null, LANDCANVAS = null;
let SAMPLER = null, FIELD = 'synthetic', GRID = null;
let DISP_T = 0, PINNED_T = 0, EPOCH0 = Math.floor(Date.now() / 1000), HORIZON_H = 192, MAXT = 384;
let result = null, origin = SF;
let START_T = 0;
let pickingForModal = false;
let _isoCache = null; // pre-processed isochrone draw data, rebuilt on each new result
let CACHE = null, LOAD_CYCLE = null, LIVE_OFF = false, reqSeq = 0;
let ZOOMED = false;
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

// ---- Zoom / pan ----
function _applyZoom(cx, cy, factor) {
  const p = unpx(cx, cy);
  const latSpan = Math.min(BASE_RVIEW.latMax - BASE_RVIEW.latMin, Math.max(3,  (RVIEW.latMax - RVIEW.latMin) / factor));
  const lonSpan = Math.min(BASE_RVIEW.lonMax - BASE_RVIEW.lonMin, Math.max(7,  (RVIEW.lonMax - RVIEW.lonMin) / factor));
  RVIEW.lonMin = p.lon - (cx / W) * lonSpan;  RVIEW.lonMax = RVIEW.lonMin + lonSpan;
  RVIEW.latMax = p.lat + (cy / H) * latSpan;  RVIEW.latMin = RVIEW.latMax - latSpan;
}
function _applyPan(dx, dy) {
  const dLon = -dx / W * (RVIEW.lonMax - RVIEW.lonMin);
  const dLat =  dy / H * (RVIEW.latMax - RVIEW.latMin);
  RVIEW.lonMin += dLon; RVIEW.lonMax += dLon;
  RVIEW.latMin += dLat; RVIEW.latMax += dLat;
}
function _updateZoomBtn() {
  document.getElementById('zoom-reset').style.display = ZOOMED ? 'block' : 'none';
}
function zoomAt(cx, cy, factor) { _applyZoom(cx, cy, factor); ZOOMED = true; _updateZoomBtn(); scheduleDraw(); }
function panBy(dx, dy)          { _applyPan(dx, dy);          ZOOMED = true; _updateZoomBtn(); scheduleDraw(); }
function resetView()            { Object.assign(RVIEW, BASE_RVIEW); ZOOMED = false; _updateZoomBtn(); scheduleDraw(); }

// ---- Worker ----
const worker = new Worker('/worker.js', { type: 'module' });
let resolveCompute = null;
worker.onmessage = (e) => {
  if (e.data.type === 'result') {
    result = e.data;
    if (START_T > 0 && FIELD === 'live') {
      const sl = document.getElementById('timeslider');
      sl.value = Math.min(START_T, +sl.max);
      DISP_T = PINNED_T = +sl.value;
      updateTimeLabel();
    }
    buildIsoCache();
    scheduleDraw();
    telemetry();
    if (resolveCompute) { resolveCompute(); resolveCompute = null; }
  } else if (e.data.type === 'error') {
    console.error('[worker]', e.data.message);
    if (resolveCompute) { resolveCompute(); resolveCompute = null; }
  }
};
function compute() {
  return new Promise(resolve => {
    resolveCompute = resolve;
    worker.postMessage({ origin, dest: ROUTE_DEST, polar: POLAR, polarEff: POLAR_EFF, grid: GRID, startT: START_T });
  });
}

// ---- Synthetic environment (offline fallback for rendering) ----
function synthEnv(lat, lon) {
  const d = distNm(HIGH, { lat, lon }), brg = bearing(HIGH, { lat, lon }), twd = (brg + 270) % 360;
  const tws = Math.min(27, 27 * (1 - Math.exp(-d / 520)));
  return { tws, twd, waveHeight: 0.18*tws+0.7, wavePeriod: 5+tws/3.5, waveDir: twd, swellDir: twd, curSpeed: 0.3, curDir: 270, pressure: 1013 };
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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); scheduleDraw();
}
function drawOcean() {
  const g = ctx.createRadialGradient(W*0.5, H*0.42, 80, W*0.5, H*0.5, Math.max(W,H)*0.75);
  g.addColorStop(0, '#0c2230'); g.addColorStop(1, '#061019'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
function drawCalifornia() {
  ctx.save();
  ctx.beginPath();
  let first = true;
  for (const [lat, lon] of CALIFORNIA_COAST) {
    const [x, y] = px(lat, lon);
    const cx = Math.min(W + 4, x);
    if (first) { ctx.moveTo(cx, y); first = false; }
    else ctx.lineTo(cx, y);
  }
  // Close via bottom-right and top-right corners to fill all inland area
  ctx.lineTo(W + 4, H + 4);
  ctx.lineTo(W + 4, -4);
  ctx.closePath();
  ctx.fillStyle = 'rgba(28,40,34,0.95)';
  ctx.fill();
  ctx.restore();
}
function drawLand() {
  if (!LANDCANVAS) return;
  // Land mask PNG covers VIEW; project it into the wider RVIEW canvas
  const [lx, ty] = px(VIEW.latMax, VIEW.lonMin);
  const [rx, by] = px(VIEW.latMin, VIEW.lonMax);
  ctx.drawImage(LANDCANVAS, lx, ty, rx - lx, by - ty);
  drawCalifornia();
  drawIslands();
}
function drawIslands() {
  if (!ISLANDS.length) return;
  ctx.save();
  ctx.fillStyle = 'rgba(28,40,34,0.95)';
  for (const poly of ISLANDS) {
    ctx.beginPath();
    let first = true;
    for (const [lat, lon] of poly) {
      const [x, y] = px(lat, lon);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
function drawGraticule() {
  ctx.strokeStyle = 'rgba(86,152,168,0.14)'; ctx.fillStyle = '#4a7d8a';
  ctx.lineWidth = 1; ctx.font = "10px 'IBM Plex Mono'";
  for (let lat = 20; lat <= 40; lat += 5) {
    const [, y] = px(lat, VIEW.lonMin);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(lat+'°N', 6, y-4);
  }
  for (let lon = -165; lon <= -110; lon += 5) {
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
function buildIsoCache() {
  _isoCache = null;
  if (!result || !result.isochrones) return;
  const tr = result.track;
  const CORR = 250;
  const coarse = tr.filter((_, i) => i % 5 === 0);
  const inCorridor = p => !coarse.length || coarse.some(t => distNm(p, t) < CORR);
  // Arc filter: keep only points within ±90° of the great-circle bearing to the destination.
  // Using the first-step heading here breaks for arcing passages (e.g. Transpac) where the
  // initial step direction diverges from the overall route, causing the corridor to miss the
  // second half of the track.
  const optHdg = bearing(origin, DEST);
  const inArc = p => Math.abs(angDiff(bearing(origin, p), optHdg)) <= 90;
  _isoCache = result.isochrones.map((front, i) => {
    if (i < 2) return null; // skip first 6 h — too close to origin
    if (front.length < 2) return null;
    const pts = front
      .filter(p => inCorridor(p) && inArc(p))
      .sort((a, b) => bearing(origin, a) - bearing(origin, b));
    return pts.length >= 2 ? { pts, major: i % 8 === 0 } : null;
  }).filter(Boolean);
}
function drawIsochrones() {
  if (!_isoCache || !_isoCache.length) return;
  ctx.save();
  // Clip the California coast out of the isochrone layer (evenodd rule).
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  let clipFirst = true;
  for (const [lat, lon] of CALIFORNIA_COAST) {
    const [x, y] = px(lat, lon);
    const cx = Math.min(W + 4, x);
    if (clipFirst) { ctx.moveTo(cx, y); clipFirst = false; } else ctx.lineTo(cx, y);
  }
  ctx.lineTo(W + 4, H + 4);
  ctx.lineTo(W + 4, -4);
  ctx.closePath();
  for (const poly of ISLANDS) {
    let first = true;
    for (const [lat, lon] of poly) {
      const [x, y] = px(lat, lon);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  ctx.clip('evenodd');
  // Two-pass batching: draw all minor fronts in one stroke, all major in another.
  for (const isMajor of [false, true]) {
    ctx.strokeStyle = isMajor ? 'rgba(63,205,224,0.55)' : 'rgba(63,205,224,0.16)';
    ctx.lineWidth = isMajor ? 1.3 : 0.8;
    ctx.beginPath();
    for (const { pts, major } of _isoCache) {
      if (major !== isMajor) continue;
      for (let j = 1; j < pts.length; j++) {
        if (distNm(pts[j-1], pts[j]) > 400) continue; // skip corridor gaps
        const [x1, y1] = px(pts[j-1].lat, pts[j-1].lon);
        const [x2, y2] = px(pts[j].lat, pts[j].lon);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
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
    const h = bearing(tr[s], tr[s+1]), e = getEnv(tr[s].lat, tr[s].lon, tr[s].t);
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
  if (sailFor(twa, tws, ASYM).includes('Spinnaker')) return 'kite';
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
function drawCurrents() {
  const step = 2.5;
  for (let lat = RVIEW.latMin + step/2; lat < RVIEW.latMax; lat += step)
    for (let lon = RVIEW.lonMin + step/2; lon < RVIEW.lonMax; lon += step) {
      const e = getEnv(lat, lon, DISP_T);
      if (e.curSpeed < 0.05) continue;
      const [x, y] = px(lat, lon);
      const len = 6 + Math.min(18, e.curSpeed * 14);
      arrow(x, y, e.curDir, len, 'rgba(100,200,255,0.7)');
    }
}
function _marchSegs(lats, lons, vals, iso) {
  const segs = [];
  const nR = lats.length, nC = lons.length;
  for (let r = 0; r < nR - 1; r++) {
    for (let c = 0; c < nC - 1; c++) {
      const la0 = lats[r], la1 = lats[r+1], lo0 = lons[c], lo1 = lons[c+1];
      const v00 = vals[r][c], v01 = vals[r][c+1], v10 = vals[r+1][c], v11 = vals[r+1][c+1];
      const code = (v00>=iso?1:0)|(v01>=iso?2:0)|(v10>=iso?4:0)|(v11>=iso?8:0);
      if (code === 0 || code === 15) continue;
      const lp = (va, vb, fa, fb) => fa + (fb - fa) * ((iso - va) / (vb - va));
      const t  = () => px(la0, lp(v00, v01, lo0, lo1));
      const b  = () => px(la1, lp(v10, v11, lo0, lo1));
      const l  = () => px(lp(v00, v10, la0, la1), lo0);
      const rE = () => px(lp(v01, v11, la0, la1), lo1);
      const sg = (p1, p2) => segs.push([...p1, ...p2]);
      switch (code) {
        case  1: case 14: sg(t(), l());        break;
        case  2: case 13: sg(t(), rE());       break;
        case  3: case 12: sg(l(), rE());       break;
        case  4: case 11: sg(l(), b());        break;
        case  5: case 10: sg(t(), b());        break;
        case  6: sg(t(), rE()); sg(l(), b());  break;
        case  7: case  8: sg(rE(), b());       break;
        case  9: sg(t(), l());  sg(rE(), b()); break;
      }
    }
  }
  return segs;
}
function drawIsobars() {
  const step = 2, pLo = 976, pHi = 1044;
  const lats = [], lons = [];
  for (let lat = RVIEW.latMin; lat <= RVIEW.latMax + 0.01; lat += step) lats.push(lat);
  for (let lon = RVIEW.lonMin; lon <= RVIEW.lonMax + 0.01; lon += step) lons.push(lon);
  const vals = lats.map(la => lons.map(lo2 => getEnv(la, lo2, DISP_T).pressure));
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.font = "9px 'IBM Plex Mono'";
  for (let iso = pLo; iso <= pHi; iso += 4) {
    const segs = _marchSegs(lats, lons, vals, iso);
    if (!segs.length) continue;
    const major = iso % 20 === 0;
    ctx.strokeStyle = major ? 'rgba(200,200,255,0.55)' : 'rgba(180,180,255,0.35)';
    ctx.lineWidth = major ? 1.2 : 0.7;
    ctx.beginPath();
    for (const [x1,y1,x2,y2] of segs) { ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); }
    ctx.stroke();
    if (major && segs.length > 0) {
      const s = segs[Math.floor(segs.length / 2)];
      ctx.fillStyle = 'rgba(200,200,255,0.65)';
      ctx.fillText(`${iso}`, (s[0]+s[2])/2, (s[1]+s[3])/2);
    }
  }
  // Label high (H) and low (L) pressure centres — 8-neighbour local extrema
  const nR = lats.length, nC = lons.length;
  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let r = 1; r < nR - 1; r++) {
    for (let c = 1; c < nC - 1; c++) {
      const v = vals[r][c];
      let isMax = true, isMin = true;
      for (let dr = -1; dr <= 1 && (isMax || isMin); dr++)
        for (let dc = -1; dc <= 1 && (isMax || isMin); dc++) {
          if (dr === 0 && dc === 0) continue;
          const n = vals[r+dr][c+dc];
          if (n >= v) isMax = false;
          if (n <= v) isMin = false;
        }
      if (!isMax && !isMin) continue;
      const [x, y] = px(lats[r], lons[c]);
      const p = Math.round(v);
      if (isMax) {
        ctx.font = "bold 18px 'Saira'"; ctx.fillStyle = 'rgba(255,80,80,0.95)';
        ctx.fillText('H', x, y);
        ctx.font = "10px 'IBM Plex Mono'"; ctx.fillStyle = 'rgba(255,150,150,0.85)';
        ctx.fillText(`${p}`, x, y + 14);
      } else {
        ctx.font = "bold 18px 'Saira'"; ctx.fillStyle = 'rgba(80,140,255,0.95)';
        ctx.fillText('L', x, y);
        ctx.font = "10px 'IBM Plex Mono'"; ctx.fillStyle = 'rgba(150,190,255,0.85)';
        ctx.fillText(`${p}`, x, y + 14);
      }
    }
  }
  ctx.restore();
}
function drawSwellDir() {
  const step = 2.5;
  for (let lat = RVIEW.latMin + step/2; lat < RVIEW.latMax; lat += step)
    for (let lon = RVIEW.lonMin + step/2; lon < RVIEW.lonMax; lon += step) {
      const e = getEnv(lat, lon, DISP_T);
      if (e.waveHeight < 0.3) continue;
      const [x, y] = px(lat, lon);
      const len = 5 + Math.min(16, e.waveHeight * 4);
      arrow(x, y, (e.swellDir + 180) % 360, len, 'rgba(58,110,185,0.75)');
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
  label(DEST, DEST_LABEL, '#ff6b5e');
  const inactiveStart = activeRoute === 'paccup' ? SAN_PEDRO : SF;
  const inactiveStartLabel = activeRoute === 'paccup' ? 'SAN PEDRO' : 'SAN FRANCISCO';
  marker(inactiveStart, '#4a7d8a', 4); label(inactiveStart, inactiveStartLabel, '#4a7d8a');
  if (!livePos) {
    const originLabel = origin === SF ? 'SAN FRANCISCO' : origin === SAN_PEDRO ? 'SAN PEDRO' : 'POSITION';
    marker(origin, '#5fe39a', 5); label(origin, originLabel, '#5fe39a');
  }
}
let _rafPending = false;
function scheduleDraw() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => { _rafPending = false; draw(); });
}
function draw() {
  drawOcean(); drawGraticule();
  if (document.getElementById('t-wave').checked) drawWaves();
  if (document.getElementById('t-wind').checked) drawWind();
  if (document.getElementById('t-curr').checked) drawCurrents();
  if (document.getElementById('t-isobar').checked) drawIsobars();
  if (document.getElementById('t-swell').checked) drawSwellDir();
  if (document.getElementById('t-land').checked) drawLand();
  if (document.getElementById('t-iso').checked) drawIsochrones();
  if (document.getElementById('t-track').checked) { drawTrack(); drawGybes(); drawSailChanges(); }
  drawMarkers(); if (livePos) { drawBoatHeading(); placeBoatDot(); }
}

// ---- Telemetry ----
function sailedNm(tr) { let s = 0; for (let i = 1; i < tr.length; i++) s += distNm(tr[i-1], tr[i]); return s; }
function fmtDur(h) { const d = Math.floor(h/24); return `${d}d ${Math.round(h-d*24)}h`; }
function fmtShortDur(h) {
  if (h < 1) return `~${Math.round(h * 60)}m`;
  const hrs = Math.round(h), d = Math.floor(hrs / 24), rem = hrs % 24;
  return d > 0 ? `~${d}d ${rem}h` : `~${hrs}h`;
}
function timeToNextSailChange() {
  if (!result || result.track.length < 3) return null;
  const tr = result.track;
  const h0 = bearing(tr[0], tr[1]);
  const e0 = getEnv(tr[1].lat, tr[1].lon, tr[1].t);
  const twa0 = Math.abs(((e0.twd - h0 + 540) % 360) - 180);
  const startCat = sailCat(twa0, e0.tws);
  for (let i = 2; i < tr.length; i++) {
    const h = bearing(tr[i - 1], tr[i]);
    const e = getEnv(tr[i].lat, tr[i].lon, tr[i].t);
    const twa = Math.abs(((e.twd - h + 540) % 360) - 180);
    if (sailCat(twa, e.tws) !== startCat) return tr[i].t - tr[0].t;
  }
  return null;
}
function telemetry() {
  const el = document.getElementById('telemetry'); if (!result) { el.innerHTML = ''; return; }
  const gc = distNm(origin, DEST), sailed = sailedNm(result.track);
  const dur = result.hours - START_T;
  el.innerHTML = `<div class="row"><span class="k">PASSAGE TIME</span></div><div class="big">${fmtDur(dur)}</div>`
    + (START_T > 0 ? `<div class="row"><span class="k">departs</span><span class="v">+${fmtDur(START_T)}</span></div>` : '')
    + `<div class="row"><span class="k">great-circle</span><span class="v">${Math.round(gc)} nm</span></div>`
    + `<div class="row"><span class="k">sailed</span><span class="v">${Math.round(sailed)} nm</span></div>`
    + `<div class="row"><span class="k">avg SOG</span><span class="v">${(sailed/Math.max(1,dur)).toFixed(1)} kt</span></div>`
    + `<div class="row"><span class="k">extra distance</span><span class="v">+${Math.round((sailed/gc-1)*100)}%</span></div>`
    + `<div class="row"><span class="k">gybes</span><span class="v">${gybes(result.track).length}</span></div>`;
}
function sailFor(twa, tws, asym = false) {
  if (twa < 42) return 'Pinching — no drive';
  if (twa < 70) return 'Main + Genoa — close-hauled';
  if (twa < 90) return 'Main + Genoa — close reach';
  if (twa < 110) return tws > 22 ? 'Main + Jib — beam reach' : 'Main + Genoa — beam reach';
  const kite = asym ? 'Spinnaker (asym)' : 'Spinnaker (sym)';
  if (twa < 150) return tws > 24 ? 'Main + poled jib — heavy air' : `${kite} — broad reach`;
  return tws > 24 ? 'Main + poled jib — heavy air' : `${kite} — running deep`;
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
function restoreDispT() {
  if (FIELD === 'live' && DISP_T !== PINNED_T) { DISP_T = PINNED_T; updateTimeLabel(); scheduleDraw(); }
}
function showTooltip(mx, my) {
  const near = document.getElementById('t-track').checked ? nearestOnTrack(mx, my) : null;
  cursorEl.style.display = 'block'; cursorEl.style.left = (mx+14)+'px'; cursorEl.style.top = (my+14)+'px';
  if (near && near.d < 14) {
    if (FIELD === 'live') {
      const snapT = Math.max(0, Math.min(MAXT, Math.round(near.t)));
      if (snapT !== DISP_T) { DISP_T = snapT; updateTimeLabel(); scheduleDraw(); }
    }
    const e = getEnv(near.lat, near.lon, near.t), twa = angDiff(e.twd, near.heading);
    const tack = (((e.twd - near.heading + 540) % 360) - 180) > 0 ? 'STBD' : 'PORT';
    routedot.style.display = 'block'; routedot.style.left = near.x+'px'; routedot.style.top = near.y+'px';
    cursorEl.innerHTML = `<span class="lbl">heading</span> ${Math.round(near.heading)}°  <span class="lbl">tack</span> ${tack}<br>`
      + `<span class="lbl">TWA</span> ${Math.round(twa)}°  <span class="lbl">wind</span> ${Math.round(e.tws)} kt<br>`
      + `<span class="lbl">sail</span> ${sailFor(twa, e.tws, ASYM)}<br>`
      + `<span class="lbl">ETA</span> +${fmtDur(near.t)}`;
  } else {
    restoreDispT(); routedot.style.display = 'none';
    const p = unpx(mx, my), e = getEnv(p.lat, p.lon, DISP_T);
    cursorEl.innerHTML = `<span class="lbl">pos </span>${p.lat.toFixed(1)}°N ${Math.abs(p.lon).toFixed(1)}°W<br>`
      + `<span class="lbl">wind</span> ${Math.round(e.tws)} kt from ${Math.round(e.twd)}°<br>`
      + `<span class="lbl">sea </span> Hs ${e.waveHeight.toFixed(1)} m @ ${e.wavePeriod.toFixed(0)} s`;
  }
}

// Mouse — pan + tooltip
let panStart = null, panMoved = false;
cv.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  panStart = { x: ev.clientX, y: ev.clientY }; panMoved = false;
  cv.style.cursor = 'grabbing';
});
cv.addEventListener('mousemove', ev => {
  if (panStart) {
    const dx = ev.clientX - panStart.x, dy = ev.clientY - panStart.y;
    if (!panMoved && Math.hypot(dx, dy) > 4) panMoved = true;
    if (panMoved) { panBy(dx, dy); panStart = { x: ev.clientX, y: ev.clientY }; return; }
  }
  showTooltip(ev.clientX, ev.clientY);
});
cv.addEventListener('mouseup',   () => { panStart = null; cv.style.cursor = ''; });
cv.addEventListener('mouseleave', () => {
  panStart = null; cv.style.cursor = '';
  cursorEl.style.display = 'none'; routedot.style.display = 'none'; restoreDispT();
});
cv.addEventListener('click', ev => {
  if (panMoved) { panMoved = false; return; }
  const p = unpx(ev.clientX, ev.clientY);
  if (pickingForModal) {
    document.getElementById('dep-lat').value = p.lat.toFixed(2);
    document.getElementById('dep-lon').value = (-p.lon).toFixed(2);
    document.getElementById('pick-banner').hidden = true;
    pickingForModal = false;
    cv.style.cursor = 'crosshair';
    document.getElementById('depart-modal').hidden = false;
    return;
  }
  if (distNm(p, DEST) < 60) return;
  origin = { lat: +p.lat.toFixed(2), lon: +p.lon.toFixed(2) }; replan();
});
cv.addEventListener('dblclick', () => resetView());
cv.addEventListener('wheel', ev => {
  ev.preventDefault();
  zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.25 : 1 / 1.25);
}, { passive: false });

// Touch — pinch-to-zoom + pan + tap-to-reroute + double-tap-to-reset
let touchStart = null, lastTap = 0, pinchDist0 = null;
cv.addEventListener('touchstart', ev => {
  ev.preventDefault();
  const t = ev.touches; panMoved = false;
  if (t.length === 1) {
    touchStart = panStart = { x: t[0].clientX, y: t[0].clientY };
  } else if (t.length === 2) {
    pinchDist0 = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
    panStart = { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
    touchStart = null;
  }
}, { passive: false });
cv.addEventListener('touchmove', ev => {
  ev.preventDefault();
  const t = ev.touches;
  if (t.length === 1 && panStart) {
    const dx = t[0].clientX - panStart.x, dy = t[0].clientY - panStart.y;
    if (Math.hypot(dx, dy) > 4) panMoved = true;
    panBy(dx, dy); panStart = { x: t[0].clientX, y: t[0].clientY };
  } else if (t.length === 2 && panStart) {
    const mx = (t[0].clientX + t[1].clientX) / 2, my = (t[0].clientY + t[1].clientY) / 2;
    const dist = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
    _applyPan(mx - panStart.x, my - panStart.y);
    if (pinchDist0) _applyZoom(mx, my, dist / pinchDist0);
    pinchDist0 = dist; panStart = { x: mx, y: my };
    ZOOMED = true; _updateZoomBtn(); scheduleDraw();
    panMoved = true;
  }
}, { passive: false });
cv.addEventListener('touchend', ev => {
  ev.preventDefault();
  if (ev.touches.length === 0) {
    if (!panMoved && touchStart) {
      const now = Date.now();
      if (now - lastTap < 300) { resetView(); lastTap = 0; }
      else {
        lastTap = now;
        const p = unpx(touchStart.x, touchStart.y);
        if (pickingForModal) {
          document.getElementById('dep-lat').value = p.lat.toFixed(2);
          document.getElementById('dep-lon').value = (-p.lon).toFixed(2);
          document.getElementById('pick-banner').hidden = true;
          pickingForModal = false;
          cv.style.cursor = 'crosshair';
          document.getElementById('depart-modal').hidden = false;
        } else if (distNm(p, DEST) >= 60) {
          origin = { lat: +p.lat.toFixed(2), lon: +p.lon.toFixed(2) }; replan();
        }
      }
    }
    panStart = touchStart = null; pinchDist0 = null; panMoved = false;
  } else if (ev.touches.length === 1) {
    panStart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    pinchDist0 = null;
  }
}, { passive: false });

// ---- Controls wiring ----
document.querySelectorAll('#controls input').forEach(c => c.addEventListener('change', scheduleDraw));
document.getElementById('reset').addEventListener('click', () => { origin = ROUTES[activeRoute].origin; START_T = 0; resetView(); replan(); });
document.getElementById('routerow').addEventListener('click', e => {
  const btn = e.target.closest('.routebtn');
  if (!btn || btn.dataset.route === activeRoute) return;
  activeRoute = btn.dataset.route;
  document.querySelectorAll('.routebtn').forEach(b => b.classList.toggle('active', b.dataset.route === activeRoute));
  const r = ROUTES[activeRoute];
  DEST = r.dest; ROUTE_DEST = r.routeDest ?? r.dest; DEST_LABEL = r.destLabel; DEST_NAME = r.destName;
  origin = r.origin; START_T = 0;
  document.getElementById('reset').textContent = r.resetLabel;
  resetView(); replan();
});
document.getElementById('zoom-reset').addEventListener('click', resetView);
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
  const when = fmtPacific((EPOCH0 + DISP_T*3600)*1000);
  document.getElementById('timelabel').textContent = '+'+d+'d '+h+'h · '+when;
}
function setupSlider(live) {
  const w = document.getElementById('timewrap'); w.style.display = live ? 'block' : 'none';
  if (!live) return;
  const s = document.getElementById('timeslider'); s.max = Math.floor(MAXT); s.step = 3; s.value = 0; DISP_T = 0; PINNED_T = 0; updateTimeLabel();
}
document.getElementById('timeslider').addEventListener('input', e => { PINNED_T = +e.target.value; DISP_T = PINNED_T; updateTimeLabel(); scheduleDraw(); });
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
    CACHE = { cycle: cyc, env }; LOAD_CYCLE = cyc; applyEnv(env);
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
  POLAR = BOATS[id].polar;
  ASYM = BOATS[id].asymSpinnaker ?? false;
  document.getElementById('boat').value = id;
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
    BOATS[id] = { name: file.name.replace(/\.pdf$/i,'').slice(0,26)||'Uploaded cert', meta: 'uploaded ORR cert', loa: null, polar, asymSpinnaker: polar.asymSpinnaker ?? false };
    BOAT_ORDER.push(id); populateBoatSelect(); setBoat(id);
    msg.textContent = '✓ polar loaded · '+polar.tws.length+' wind speeds × '+polar.twa.length+' angles';
    msg.className = 'certmsg ok';
  } catch (err) { msg.textContent = '✗ '+err.message; msg.className = 'certmsg err'; }
}

// ---- Depart modal ----
function openDepartModal() {
  document.getElementById('dep-lat').value = origin.lat.toFixed(2);
  document.getElementById('dep-lon').value = (-origin.lon).toFixed(2);
  const sl = document.getElementById('dep-tslider');
  sl.max = FIELD === 'live' ? Math.floor(MAXT) : 384;
  sl.value = START_T;
  updateDepTime();
  document.getElementById('depart-modal').hidden = false;
}
function closeDepartModal() {
  document.getElementById('depart-modal').hidden = true;
  if (pickingForModal) {
    pickingForModal = false;
    document.getElementById('pick-banner').hidden = true;
    cv.style.cursor = 'crosshair';
  }
}
function updateDepTime() {
  const h = +document.getElementById('dep-tslider').value;
  const disp = document.getElementById('dep-tdisp');
  if (h === 0) { disp.textContent = 'Now'; return; }
  if (FIELD === 'live') {
    const d = Math.floor(h / 24), r = h % 24;
    const when = fmtPacific((EPOCH0 + h * 3600) * 1000);
    disp.textContent = `+${d}d ${r}h · ${when}`;
  } else {
    const d = Math.floor(h / 24), r = h % 24;
    disp.textContent = `+${d}d ${r}h`;
  }
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

document.getElementById('depart').addEventListener('click', openDepartModal);
document.getElementById('dep-cancel').addEventListener('click', closeDepartModal);
document.getElementById('depart-modal').addEventListener('click', e => { if (e.target.id === 'depart-modal') closeDepartModal(); });
document.getElementById('dep-pick').addEventListener('click', () => {
  document.getElementById('depart-modal').hidden = true;
  document.getElementById('pick-banner').hidden = false;
  pickingForModal = true;
  cv.style.cursor = 'cell';
});
document.getElementById('dep-tslider').addEventListener('input', updateDepTime);
document.getElementById('dep-go').addEventListener('click', () => {
  const latVal = +document.getElementById('dep-lat').value;
  const lonVal = +document.getElementById('dep-lon').value;
  if (!latVal || !lonVal) return;
  origin = { lat: +latVal.toFixed(2), lon: +(-(+lonVal)).toFixed(2) };
  START_T = +document.getElementById('dep-tslider').value;
  closeDepartModal();
  replan();
});

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
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { closeGeo(); closeCert(); closeDepartModal(); } });

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
  const sailChg = timeToNextSailChange();
  const sailChgStr = sailChg != null ? fmtShortDur(sailChg) : '—';
  document.getElementById('hud-body').innerHTML =
    '<div class="hrow"><span class="k">optimal hdg</span></div>'
    +'<div class="hbig">'+(opt != null ? opt+'°T' : '—')+'</div>'
    +'<div class="hrow"><span class="k">next sail change</span><span class="v">'+sailChgStr+'</span></div>'
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
  placeBoatDot(); scheduleDraw();
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
  scheduleDraw();
}
document.getElementById('track').addEventListener('click', function() { watchId == null ? startTracking() : stopTracking(); });

// ---- Stale forecast detection ----
function checkStaleness() {
  if (!LOAD_CYCLE || FIELD !== 'live') return;
  document.getElementById('stale-bar').hidden = expectedCycle() <= LOAD_CYCLE;
}
setInterval(checkStaleness, 30 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStaleness(); });
document.getElementById('stale-reload').addEventListener('click', () => location.reload());

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
