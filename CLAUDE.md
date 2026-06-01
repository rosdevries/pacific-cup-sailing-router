# Pacific Cup Sailing Router

Browser-based weather-routing app for the Pacific Cup passage (San Francisco → Kaneohe Bay,
Oahu, ~2,050 nm). It pulls public weather + a boat polar and draws the time-optimal sailing
route on a chart, with live re-routing, boat selection / ORR-certificate upload, and live GPS
tracking while sailing.

A complete, **validated, self-contained prototype** already exists at
`prototype/router-demo.html` — open it in a browser and it works. Your job is to productionize
it (modularize, add a shared forecast cache so ~15 concurrent users don't hammer the data
source, deploy to Railway). **The prototype is the source of truth for all algorithms and UI.**
Do not re-derive the routing math or re-litigate the decisions below — port them.

## Status / goal
- DONE (in prototype): isochrone router, live Open-Meteo pipeline, synthetic fallback, GSHHG
  land avoidance, boat library + ORR cert upload, polar-efficiency control, geolocation
  one-shot + continuous `watchPosition` tracking, per-GFS-cycle client caching.
- TO BUILD: extract the inlined prototype into modules; a small **backend** that fetches each
  forecast once per model cycle and serves a **shared** cache to all clients; move the route
  solve into a **Web Worker**; deploy to Railway. See `docs/BUILD_PLAN.md`.

## Decisions already made (do not re-open without reason)
- **Weather data: Open-Meteo** (CORS-enabled, free *non-commercial*, no key, JSON).
  - Wind: `https://api.open-meteo.com/v1/forecast` — `wind_speed_10m,wind_direction_10m`,
    `wind_speed_unit=kn` (GFS, 16-day horizon).
  - Waves + currents: `https://marine-api.open-meteo.com/v1/marine` —
    `wave_height,wave_direction,wave_period,ocean_current_velocity,ocean_current_direction`,
    `length_unit=metric` (GFS-Wave, ~8-day horizon).
  - Underlying model: **GFS, updates every 6 h** (00/06/12/18 UTC cycles, available ~3.5–5 h
    after init). This is the single most important fact for caching (see below).
- **Routing: isochrone method.** From each frontier node, fan ALL headings (do NOT bias toward
  the destination — the optimal SF→HI route dives south around the Pacific High), advance a
  fixed `dt`, prune by bearing-sector keeping the farthest node per sector. First front to reach
  the destination wins; backtrack parent pointers. Full math in `docs/ALGORITHMS.md`.
- **Polars: ORR / ORC.** Normalized schema `{tws[], twa[], speed[twa][tws], beat:{angle[],speed[]}}`.
  Built-in library in `data/boats.json` (Santa Cruz 40 from a real ORR cert + TP52 / Sun Fast
  3300 / Cape 31 from ORC public VPP data). Users can upload an ORR certificate PDF; the
  prototype parses **page 2's first "Table of Boat Speed Polars"** (not the page-3 fleet-adjusted
  copy) in-browser via pdf.js.
- **Polar efficiency factor** (default 0.90): scales achieved speed vs the VPP target to model
  real-world crew/seaway losses. VPP polars are flat-water theoretical maxima; without this the
  passage comes out ~15% too fast (e.g. SC40 ~8.9 d vs the real ~10 d record). At 0.85 the model
  matches the Pac Cup record.
- **Land avoidance: GSHHG raster mask.** `data/corridor-landmask.png` (baked by
  `scripts/make-landmask.py` from high-res GSHHG). Test the WHOLE leg, not just endpoints.
- **Forecast caching: by GFS model cycle** (see Storage + caching below).

## CRITICAL conventions / gotchas (these have bitten us)
- **Direction conventions differ by variable:** wind direction and wave direction are "**from**";
  ocean-current direction is "**toward**". All bearings are compass degrees (0 = N, clockwise).
- **Interpolate directions as sin/cos components, never as raw degrees** — averaging 350° and
  10° must give 0°, not 180°. The env grid stores `*_x`/`*_y` components for every direction
  field; the sampler interpolates those and recovers the angle with `atan2`.
- **The route solve is synchronous (~1–2 s).** In production run it in a **Web Worker** so the
  map/marker stay fluid (esp. during live-tracking re-solves).
- **Geolocation needs a secure context** (https or localhost). It will fail in plain http / many
  sandboxes — already handled gracefully (permission/unavailable/timeout messages, auto-stop on
  hard denial). Don't "fix" the failure path; it's intentional.
- **Open-Meteo free tier:** < 10,000 calls/day, 5,000/hr, 600/min; **non-commercial only**;
  **CC-BY 4.0** → you MUST credit DWD + Open-Meteo in the UI. They block abusive IPs. The
  **metadata API is NOT counted** against limits — use it to detect a new cycle. If this ever
  gets ads/subscriptions it becomes commercial use → their customer API (key, ~€99/mo,
  `customer-api.open-meteo.com`); extreme scale → self-host off their AWS S3 open-data mirror.
- **Per-IP vs shared-IP:** pure client-side fetching spreads load across users' IPs (15 users is
  fine). Once you proxy through one server IP, you MUST cache per cycle or you'll burn the daily
  limit in hours. The backend solves both (one upstream fetch per cycle serves everyone).
- **Env grid is a flat Float32Array**, index `(ti*nLat + iy)*nLon + ix`. Keep this layout if you
  serialize the grid for the cache.

## Storage + caching (answers "GitHub vs Railway volume")
Two kinds of data, two homes:
- **Static, version-controlled → the GitHub repo:** the land mask PNG, `data/boats.json`, the
  coastline build script. Small, rarely changes, belongs in git.
- **Dynamic forecast cache (regenerated every 6 h, multi-MB) → a Railway volume** (persistent
  disk mounted at e.g. `/data/cache`). Never commit these to git. A scheduled prefetch writes the
  current cycle's corridor grid there; the API serves it from memory with the volume as the
  warm-restart fallback. Cache key = the GFS cycle. See `docs/ARCHITECTURE.md`.

## Run (fill in as you build)
- `npm install`
- `npm run dev` — local server + frontend
- `npm run prefetch` — fetch current GFS cycle into the cache (also runs on a 6 h Railway cron)
- Build the land mask (rarely): `python3 scripts/make-landmask.py` (needs `basemap-data-hires`)

## Key files
- `prototype/router-demo.html` — canonical working reference (everything inlined + validated)
- `docs/BUILD_PLAN.md` — phased task checklist (start here)
- `docs/ARCHITECTURE.md` — data flow, caching, storage decision, rate-limit math, API shape
- `docs/ALGORITHMS.md` — routing / polar / wave / forecast / land-mask math + conventions
- `data/boats.json`, `data/corridor-landmask.png` — static assets
- `server/index.js`, `scripts/prefetch.js` — production scaffolding to flesh out

## Coding conventions
- Node ESM (`"type":"module"`), modern JS, no TypeScript unless you choose to add it.
- Keep the core routing/forecast logic framework-agnostic (pure functions) so it runs in both the
  browser (Web Worker) and Node (prefetch). The browser/Node split is only I/O.
- Match the prototype's behavior exactly when porting; cross-check passage times against it.
