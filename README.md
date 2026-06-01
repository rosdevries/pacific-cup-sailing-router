# Pacific Cup Sailing Router

A browser-based weather-routing app for the Pacific Cup passage — **San Francisco → Kaneohe Bay,
Oahu** (~2,050 nm). It pulls live wind, waves, and currents plus a boat polar, and draws the
time-optimal sailing route on a chart. Built to be useful underway: re-route from anywhere, pick
your boat (or upload an ORR certificate), tune polar efficiency, and track your live position.

> **Working prototype:** open `prototype/router-demo.html` in a browser right now — it's the
> complete, validated reference. This repo is about turning it into a deployable multi-user app.

## What it does
- Isochrone weather routing that dives south around the Pacific High like the real fleet does.
- Live forecast from **Open-Meteo** (GFS wind + GFS-Wave waves/currents), with a synthetic
  fallback so it always renders offline.
- Boat library (Santa Cruz 40 + TP52 / Sun Fast 3300 / Cape 31) and **ORR certificate upload**
  (parses the page-2 polar in-browser).
- **Polar efficiency** control to match real-world performance (default 90%).
- GPS: one-shot "Route from my location" and continuous live tracking (`watchPosition`) with a
  live boat marker, HUD, and auto re-routing.

## Quickstart (once built — see `docs/BUILD_PLAN.md`)
```bash
npm install
cp .env.example .env       # set CACHE_DIR etc.
npm run prefetch           # fetch the current GFS cycle into the cache
npm run dev                # serve frontend + API at http://localhost:3000
```
To preview the reference prototype with no backend, just open `prototype/router-demo.html`
(live data needs HTTPS/localhost; otherwise it shows the synthetic demo field).

## Layout
```
CLAUDE.md                 ← read this first (project context for Claude Code)
docs/
  BUILD_PLAN.md           ← phased task checklist
  ARCHITECTURE.md         ← data flow, caching, storage decision, API shape
  ALGORITHMS.md           ← routing / polar / wave / forecast math + conventions
prototype/router-demo.html← canonical working reference (everything inlined)
data/
  boats.json              ← polar library (static, in git)
  corridor-landmask.png   ← baked GSHHG land mask (static, in git)
scripts/
  make-landmask.py        ← rebuild the land mask from GSHHG
  prefetch.js             ← fetch one GFS cycle into the cache (6 h cron)
server/index.js           ← serves the frontend + /api/forecast (shared cache)
src/                      ← extracted pure core (routing, forecast, polar, …)
```

## Data sources & attribution
Weather via **Open-Meteo** (GFS / GFS-Wave). Open-Meteo's free tier is **non-commercial** and
licensed **CC-BY 4.0** — the UI must credit **DWD** (data) and **Open-Meteo** (API). Coastline
from **GSHHG**. See `docs/ARCHITECTURE.md` for limits and the commercial path if this is ever
monetized.

## Deploy
Railway: a web service (frontend + API) with a **persistent volume** for the forecast cache, plus
a **6-hourly cron** running `npm run prefetch`. Static data lives in git; the regenerated forecast
grids live on the volume. Details in `docs/ARCHITECTURE.md`.
