# Build plan

Work top-down. Each phase ends in something runnable. Cross-check passage times against
`prototype/router-demo.html` after any change to the routing/forecast core.

## Phase 0 — Scaffold & extract the core (½ day)
- [ ] `npm init`, set `"type":"module"`, add deps (see `package.json`).
- [ ] Extract the inlined prototype logic into `src/` pure modules (no DOM, no fetch):
  - [ ] `src/geo.js` — `toRad, distNm, bearing, gcProject, vec, brgOf, angDiff` (prototype §geometry).
  - [ ] `src/polar.js` — polar schema + `interp1, colSpeed, polarSpeed` (prototype §boat library).
  - [ ] `src/waves.js` — `WAVE` params + `waveMult` (prototype §wave-speed penalty).
  - [ ] `src/routing.js` — `boatStep, prune, backtrack, route` (prototype §isochrone engine);
        take `{sampler, polar, polarEff, landMask}` as inputs instead of reading globals.
  - [ ] `src/forecast.js` — `bboxFor, buildGrid, omFetch, fetchForecastGrid, makeSampler,
        expectedCycle, cycLabel` (prototype §environment + Open-Meteo pipeline). Works in Node and browser.
  - [ ] `src/landmask.js` — decode PNG → `Uint8` grid, `maskLand`, `legHitsLand`.
  - [ ] `src/orrParse.js` — `linesFromContent, nums, parseORR` (browser-only; pdf.js text items).
- [ ] Unit tests that reproduce the prototype's validated numbers:
  - [ ] SC40 synthetic route reaches Kaneohe, 0 legs on land.
  - [ ] polar efficiency scales days as ~1/η (1.0→8.9 d, 0.90→9.8 d, 0.85→10.3 d).
  - [ ] `parseORR` on the sample ORR PDF reproduces the SC40 polar field-for-field.
  - [ ] direction interpolation: 350° & 10° → 0°.

## Phase 1 — Shared forecast cache backend (the "15 users" piece) (1 day)
- [ ] `server/index.js`: serve the static frontend + `GET /api/forecast` returning the current
      cycle's corridor grid (see `docs/ARCHITECTURE.md` for the API shape).
- [ ] In-memory cache keyed by GFS cycle; **Railway volume** (`CACHE_DIR`) as warm-restart store.
- [ ] `scripts/prefetch.js`: detect the latest available cycle via the **metadata API** (free),
      fetch the fixed SF→Kaneohe corridor once via `fetchForecastGrid`, write
      `${CACHE_DIR}/forecast-<cycle>.json` (+ a `latest.json` pointer).
- [ ] Wire prefetch to a **6 h Railway cron** aligned ~15 min after each cycle's availability.
- [ ] Lazy fallback: if `/api/forecast` has no cached cycle yet, run a single prefetch on demand
      (guarded so concurrent requests don't stampede the upstream).
- [ ] Confirm: N client requests within a cycle → **0** extra upstream calls (one prefetch/cycle).

## Phase 2 — Frontend on the backend + Web Worker (1 day)
- [ ] Replace the prototype's direct Open-Meteo fetch with `GET /api/forecast` (same grid shape →
      `makeSampler` is unchanged). Keep the synthetic field as the offline fallback.
- [ ] Move `route()` into a **Web Worker**; post `{origin, dest, polar, polarEff, grid}` in, get the
      track/isochrones out, so the map + live marker never freeze on a re-solve.
- [ ] Keep the per-cycle client cache as a thin layer over `/api/forecast` (cheap, fewer round-trips).

## Phase 3 — Port the UX features (½ day; mostly lift-and-shift from the prototype)
- [ ] Boat selector + `data/boats.json`; ORR cert upload (pdf.js) → `parseORR` → add boat.
- [ ] Polar-efficiency slider (default 0.90).
- [ ] Geolocation: one-shot "Route from my location" modal (boat-specific optimal heading) and
      continuous `watchPosition` tracking (live boat marker + HUD + throttled re-solve).
- [ ] Layer toggles, forecast-time scrubber, telemetry, gybe markers, wave-horizon marker.

## Phase 4 — Deploy & comply (½ day)
- [ ] Railway: web service (frontend+API) + volume mount + cron service for prefetch.
- [ ] **CC-BY 4.0 attribution** visible in the UI: credit DWD + Open-Meteo with a link.
- [ ] Health check, basic logging/metrics (upstream calls/day must stay well under 10k).
- [ ] HTTPS (Railway provides it) so geolocation works on the deployed app.

## Stretch
- [ ] Split polar efficiency into upwind vs downwind (crews hold a higher % reaching/running).
- [ ] Breadcrumb trail of actual track vs planned; flag when COG diverges from optimal heading.
- [ ] Multiple candidate routes / "what-if" departure times; routing in a `watchPosition` loop.
- [ ] If it ever monetizes: switch to Open-Meteo's commercial customer API (key) — see ARCHITECTURE.
