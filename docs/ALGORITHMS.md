# Algorithms reference

Validated against `prototype/router-demo.html` (section banners cited below). Port these exactly;
the prototype is the source of truth.

## Conventions
- Bearings: compass degrees, 0 = N, clockwise. `angDiff(a,b)` = smallest signed difference.
- **Wind direction and wave direction are "from"; current direction is "toward."**
- Speeds in knots, distances in nm (`R = 3440.065`), wave height in m, period in s.

## Geometry (prototype §geometry)
`distNm`, `bearing` (initial great-circle bearing a→b), `gcProject(p, brg, nm)` (advance along a
bearing), `vec(dirDeg, mag)` → `{x,y}`, `brgOf(x,y)` → degrees. These are pure and shared by the
browser worker and the Node prefetch.

## Polar (prototype §boat library)
Schema (see `data/boats.json`): `{ tws:[...], twa:[...], speed:[twa][tws], beat:{angle:[tws], speed:[tws]} }`.
- `speed[i][j]` = boat speed at `twa[i]`, `tws[j]` (knots, through the water).
- `beat` = the per-TWS VMG-optimal upwind angle and the boat speed at that angle.
- Grid is per-boat (ORR uses 9×10 to 180°, ORC uses ~7–9×8 to 150°); the code is grid-agnostic.

Interpolation — angle first (insert a `0,0` node and the beat node so the no-go zone ramps from
0), then linear across TWS:
```js
function colSpeed(w,twa){const ang=[0,POLAR.beat.angle[w],...POLAR.twa];
  const sp=[0,POLAR.beat.speed[w],...POLAR.speed.map(r=>r[w])];return interp1(ang,sp,twa);}
function polarSpeed(tws,twaRaw){let twa=((twaRaw%360)+360)%360;if(twa>180)twa=360-twa;
  const T=POLAR.tws,t=Math.max(T[0],Math.min(T[T.length-1],tws));let w=1;while(w<T.length-1&&T[w]<t)w++;
  const f=(t-T[w-1])/(T[w]-T[w-1]);return lerp(colSpeed(w-1,twa),colSpeed(w,twa),f);}
```
**ORC→schema conversion** (when adding boats from ORC public VPP data): ORC gives `beat_vmg`/`run_vmg`
(velocity *made good*), but `beat.speed` here is boat speed *at* the angle, so convert
`speed = vmg / cos(angle)`. ORC tabulates only to 150° TWA.

## Polar efficiency (prototype §isochrone engine + slider)
`POLAR_EFF` (default 0.90) scales achieved speed: `stw = polarSpeed(...) * waveMult(...) * POLAR_EFF`.
Models real crew/seaway losses vs the flat-water VPP target. 1.0→~8.9 d, 0.90→~9.8 d, 0.85→~10.3 d
(SC40, synthetic field). 0.85 matches the Pac Cup record.

## Wave-speed penalty (prototype §wave-speed penalty)
```js
const WAVE={k:0.40,a:1.5,b:1.0,A:0.45,B:0.55,minMult:0.40,maxMult:1.08};
function waveMult(Hs,T,waveDir,heading){if(!Hs||!T)return 1;
  const beta=toRad(angDiff(waveDir,heading)),fA=WAVE.A+WAVE.B*Math.cos(beta);
  const p=WAVE.k*Math.pow(Hs,WAVE.a)*Math.pow(T,-WAVE.b)*fA;return Math.min(WAVE.maxMult,Math.max(WAVE.minMult,1-p));}
```
Period in the denominator encodes steepness: long swell barely slows you; short steep wind-sea
bites. Head seas (`beta≈0`) penalize most; following seas barely (can even help, hence maxMult>1).

## Isochrone router (prototype §isochrone engine)
`dt=3 h`, `hStep=8°`, sector `sec=2°`, `maxH=384 h`, `maxSog=16` (finish-radius bound only).
- `boatStep(node,h,dt)`: sample env → TWA → `polarSpeed × waveMult × POLAR_EFF` = STW → add the
  current vector → SOG/COG → `gcProject` over `dt`.
- Per step, fan **all** headings `0..360` by `hStep` from every frontier node (no destination bias).
- Reject any leg whose **whole path** crosses land (`legHitsLand`, samples along the leg), not just
  endpoints.
- `prune(cands, start, sec)`: bin candidates by bearing-from-start sector, keep the farthest per
  sector — this bounds the frontier.
- Finish: when a candidate is within `dt*maxSog` of the destination and the run-in doesn't cross
  land, sail straight in. **Time that final leg at the boat's real speed** (not a flat 16 kt):
```js
const fe=getEnv(finish.lat,finish.lon,finish.t), fh=bearing(finish,dest);
const fstw=polarSpeed(fe.tws,angDiff(fe.twd,fh))*waveMult(fe.waveHeight,fe.wavePeriod,fe.waveDir,fh)*POLAR_EFF;
const fb=vec(fh,fstw), fc=vec(fe.curDir,fe.curSpeed), fsog=Math.hypot(fb.x+fc.x,fb.y+fc.y);
const legT=fsog>0?distNm(finish,dest)/fsog:distNm(finish,dest)/maxSog;
```
First front to reach the destination is fastest; backtrack `parent` pointers for the track.

## Forecast pipeline (prototype §environment + Open-Meteo pipeline)
1. `bboxFor([start,dest])` — corridor box with margin + poleward extra.
2. `buildGrid(box, step=1.5°)` — lat/lon lists (keeps point count well under Open-Meteo's 1000-loc
   limit; round coords to 2 dp to keep the URL short).
3. `omFetch` both endpoints in parallel (`timeformat=unixtime`, `cell_selection=sea`).
4. Pack into `env`: flat `Float32Array`s, index `(ti*nLat+iy)*nLon+ix`. **Store every direction as
   `*_x = sin(deg)`, `*_y = cos(deg)`** so it interpolates correctly.
5. `makeSampler(env)` → `(lat,lon,t) → {tws,twd,waveHeight,wavePeriod,waveDir,curSpeed,curDir}`,
   bilinear in space, linear in time; directions recovered via `atan2(x,y)` after interpolating
   the components. Marine horizon < wind horizon → marine values hold past their horizon.

Cycle helpers (client approximation; backend should use the metadata API instead):
```js
function expectedCycle(){const d=new Date(Date.now()-5*3600e3),h=Math.floor(d.getUTCHours()/6)*6;
  return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),h)/1000;}   // 6 h cadence, ~5 h lag
```

## Land mask (prototype §canvas, `maskLand`/`legHitsLand`; build: scripts/make-landmask.py)
High-res GSHHG coastline → rasterized to `data/corridor-landmask.png` at ~0.02° (~1.2 nm). Decoded
once into a `Uint8` grid; `maskLand(lat,lon)` is an O(1) pixel test; `legHitsLand` samples ~every
1 nm along a leg. Isochrone contours are also clipped within a ~4 nm coastal buffer so they stop
cleanly offshore.

## ORR certificate parser (prototype §boat library + ORR certificate upload; browser-only)
pdf.js → `getTextContent()` per page → `linesFromContent` reconstructs visual rows (cluster items
by y within 3 pt, order by x) → `parseORR` finds the **first** "Table of Boat Speed Polars" and
reads the `True Wind Speed`, `Up Angle`, `Speed Upkts`, and each `<angle>°` row into the schema.
Take the **first** table only (page-2 boat polar), not the page-3 fleet-adjusted copy. Validated
to reproduce the SC40 polar field-for-field from a real cert.
