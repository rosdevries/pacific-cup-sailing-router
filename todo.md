# Pacific Cup Sailing Router — Build Todo

Source of truth for all algorithms: `prototype/router-demo.html`.  
Cross-check passage times against the prototype after any change to routing/forecast core.

---

## Phase 0 — Scaffold & extract the core ✅ DONE

### Setup
- [x] Install deps: `npm install` — added `pngjs` devDependency

### Extract `src/` pure modules
- [x] **`src/geo.js`** — `toRad, distNm, bearing, gcProject, vec, brgOf, angDiff`
- [x] **`src/polar.js`** — `interp1, colSpeed, polarSpeed` (polar passed as param, not global)
- [x] **`src/waves.js`** — `WAVE` params + `waveMult`
- [x] **`src/routing.js`** — `boatStep, prune, backtrack, route` (injected `{sampler, polar, polarEff, legHitsLand}`)
- [x] **`src/forecast.js`** — `bboxFor, buildGrid, omFetch, fetchForecastGrid, makeSampler, expectedCycle, cycLabel`
- [x] **`src/landmask.js`** — `decodePngData, maskLand, legHitsLand` (VIEW exported; browser/Node decode via `decodePngData`)
- [x] **`src/orrParse.js`** — `linesFromContent, nums, parseORR`

### Unit tests — all 5 pass (`node --test`, 6.2 s total)
- [x] SC40 synthetic route reaches Kaneohe, 0 legs on land
- [x] Polar efficiency 1.0→8.9d, 0.90→9.8d, 0.85→10.3d ✓ exact
- [ ] `parseORR` on sample ORR PDF — **needs a sample ORR cert PDF** (code written; no PDF in repo)
- [x] Direction interpolation: 350° & 10° → 0°

---

## Phase 1 — Shared forecast cache backend ✅ DONE

- [x] **`server/index.js`**: static file serving + `/api/forecast` + stampede guard + volume cache
- [x] **Cycle detection**: wall-clock approximation (5h lag, 6h floor) + speculative metadata API with fallback
- [x] **`refreshCache(cycle)`**: fetches SF→Kaneohe grid, flattens Float32Arrays, writes `forecast-${cycle}.json` + `latest.json`
- [x] **Volume warm-restart**: `loadCachedGrid` checks `mem` first (hot), then `CACHE_DIR/*.json` (warm)
- [x] **Stampede guard**: `inflight` de-dupe in `getGrid()` confirmed
- [x] **`scripts/prefetch.js`**: idempotent (skips if cycle file already exists), metadata API with fallback
- [x] **Smoke test**: live fetch confirmed — 19×29×336 frames, 32MB cache written to `.cache/`; second request hits `mem` (no upstream call)
- [ ] **Railway cron**: set up in Railway UI — cron schedule `15 */6 * * *` running `npm run prefetch`, sharing the volume mount

---

## Phase 2 — Frontend + Web Worker ✅ DONE

- [x] Build the production frontend HTML entry point (`public/index.html`) — lift structure from `prototype/router-demo.html`, replace inlined scripts with module `<script type="module">` imports

- [x] **Replace direct Open-Meteo fetch**: swap `fetchForecastGrid(...)` call in frontend with `GET /api/forecast`; grid shape is identical so `makeSampler` is unchanged; keep synthetic field as offline fallback (clearly labeled "demo")

- [x] **`public/worker.js`** — Web Worker: receives `{origin, dest, polar, polarEff, grid}` via `postMessage`, runs `route()`, posts back `{track, isochrones}`; import from `src/routing.js`, `src/forecast.js`, `src/geo.js`

- [x] **Wire Worker in UI**: `new Worker('/worker.js', { type: 'module' })`; `compute()` returns a Promise; posts `{origin, dest, polar, polarEff, grid}` to worker; worker responds with `{type:'result', track, hours, isochrones, reached}`; map + live marker stay fluid during solve

- [x] **Client-side per-cycle cache**: `CACHE = {cycle, env}` keyed by `expectedCycle()` — repeated re-routes within a GFS cycle use the already-fetched grid, zero upstream calls

---

## Phase 3 — Port UX features ✅ DONE

All ported into `public/app.js`:

- [x] **Boat selector**: loads `data/boats.json`; populates dropdown; updates `POLAR` and re-solves on change
- [x] **ORR cert upload**: file input → pdf.js → `parseORR` → adds cert to selector; error message on bad PDF
- [x] **Polar-efficiency slider**: default 0.90; updates `POLAR_EFF` and calls `compute()` on change
- [x] **Geolocation — one-shot**: "Route from my location" modal; boat-specific optimal heading; degrades gracefully on denial / unavailable / timeout
- [x] **Geolocation — continuous**: `watchPosition` live boat marker + HUD; throttled re-solve (1.5 nm or 60 s); auto-stop on hard denial
- [x] **Layer toggles**: wind field, wave height, isochrones, optimal route, land — all on/off
- [x] **Forecast-time scrubber**: `DISP_T` scrubber animates wind/wave rendering over forecast hours; hidden in synthetic mode
- [x] **Route overlays**: passage time telemetry, gybe markers (diamond), wave-horizon marker + dashed segment, cursor TWA/sail/ETA on hover

---

## Phase 4 — Deploy & comply ✅ DONE

- [x] **Railway web service**: deployed via Nixpacks, `npm start`; URL: **https://paccup-router.up.railway.app**
- [x] **`CACHE_DIR=/data/cache`** env var set via CLI
- [x] **Healthcheck**: changed to `/health` (instant, no upstream) — `/api/forecast` lazy-fetches on first hit
- [x] **CC-BY 4.0 attribution**: visible in UI footer — credits DWD (data) and Open-Meteo (API) with links
- [x] **HTTPS**: Railway provides it; geolocation will work on the deployed URL
- [x] **Railway volume**: persistent volume attached at `/data/cache` via dashboard
- [x] **Railway cron**: `15 */6 * * *` → `npm run prefetch`, sharing same volume — configured via dashboard

---

## Phase 6 — Marketing page at pacific-passage.com

App stays at `app.pacific-passage.com`; static marketing page serves the apex.

### Phase 6.1 — Repo (done ✅)
- [x] `site/index.html` — self-contained landing page (inline CSS + SVG compass)
- [x] `site/robots.txt` + `site/sitemap.xml` + `site/_redirects`
- [x] `scripts/gen-og-image.mjs` — pngjs pixel-art social card generator
- [x] Favicons copied to `site/` from brand assets
- [x] `site/og-image.png` — generated (run `node scripts/gen-og-image.mjs` to regenerate)

### Phase 6.2 — Cloudflare Pages project
- [ ] Dashboard → Workers & Pages → Create → Pages
- [ ] Connect GitHub repo; Framework preset = None; Build command = (empty); Output dir = `site`
- [ ] Deploy; verify `*.pages.dev` preview (page, favicon, OG image)

### Phase 6.3 — Free the apex from Tunnel, point at Pages
- [ ] Zero Trust → Tunnels → (your tunnel) → Public Hostnames → **delete** `pacific-passage.com`
      (and `www` if present); leave `app.pacific-passage.com` → Railway intact
- [ ] Pages → Custom domains → add `pacific-passage.com` AND `www.pacific-passage.com`
      (Cloudflare creates DNS + TLS automatically)
- [ ] Add Redirect Rule: `www.pacific-passage.com/*` → `https://pacific-passage.com/$1` (301)

### Phase 6.4 — Verify
- [ ] `https://pacific-passage.com/` → marketing page; `https://www…` 301s to apex
- [ ] `https://app.pacific-passage.com/` → router app (unchanged)
- [ ] `https://pacific-passage.com/route` → 301 to app
- [ ] `/favicon.svg`, `/og-image.png`, `/robots.txt`, `/sitemap.xml` all 200

### Phase 6.5 — SEO
- [ ] Google Search Console: add `pacific-passage.com` property, submit `/sitemap.xml`
- [ ] Prime social caches: Facebook Sharing Debugger + X Card Validator on apex URL
- [ ] Confirm `robots.txt` allows crawling

---

## Stretch (post-launch)

- [ ] Split polar efficiency into upwind vs downwind components
- [ ] Breadcrumb trail of actual track vs planned; flag COG divergence from optimal heading
- [ ] Multiple candidate routes / "what-if" departure times
- [ ] Routing in a `watchPosition` loop (continuous re-routing underway)
- [ ] Commercial API migration path: if monetized, switch to `customer-api.open-meteo.com` (key, ~€99/mo)

---

## Critical gotchas (read before touching routing/forecast)

1. **Direction conventions differ**: wind/wave direction = "from"; current direction = "toward"
2. **Never interpolate raw degrees**: store `*_x = sin(deg)`, `*_y = cos(deg)`; interpolate components; recover angle with `atan2`
3. **Whole-leg land check**: `legHitsLand` samples along the leg, not just endpoints
4. **Route solve is synchronous (~1–2 s)**: always run in a Web Worker in production
5. **Geolocation needs HTTPS**: failure paths are intentional — do not "fix" them
6. **One server IP + no cache = rate limit death**: the shared cache is what makes a backend viable
7. **Polar efficiency**: VPP polars are flat-water maxima; 0.85 matches the real Pac Cup record
