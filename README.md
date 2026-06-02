# Pacific Passage

Isochrone weather-routing for offshore sailing races — **Pac Cup** (San Francisco → Kaneohe Bay) and **Transpac** (San Pedro → Diamond Head).

**Live:** [app.pacific-passage.com](https://app.pacific-passage.com) · **Info:** [pacific-passage.com](https://pacific-passage.com)

## What it does
- Isochrone solver finds the time-optimal route through a live GFS forecast.
- Weather from **Open-Meteo** (GFS wind + GFS-Wave), refreshed every 6 hours. Synthetic fallback renders offline.
- Boat library: Santa Cruz 40, TP52, Sun Fast 3300, Cal 40 — plus **ORR certificate upload** (parses the page-2 polar in-browser).
- **Polar efficiency** slider to match real-world performance (default 90%).
- GPS: one-shot "Route from my location" and continuous live tracking (`watchPosition`) with live boat marker, HUD, and auto re-routing.

## Run locally
```bash
npm install
cp .env.example .env       # set CACHE_DIR etc.
npm run prefetch           # fetch the current GFS cycle into the cache
npm run dev                # serve frontend + API at http://localhost:3000
```

## Layout
```
site/                     ← static marketing page (pacific-passage.com)
server/index.js           ← Node server: static files + /api/forecast
src/                      ← pure ES modules: routing, forecast, polar, geo, landmask
public/                   ← browser app (app.js, worker.js, index.html)
data/
  boats.json              ← polar library
  corridor-landmask.png   ← GSHHG land mask for the SF–Hawaii corridor
scripts/
  prefetch.js             ← fetch one GFS cycle into the cache (6 h cron)
  gen-og-image.mjs        ← regenerate site/og-image.png after brand changes
  make-landmask.py        ← rebuild the land mask from GSHHG
prototype/router-demo.html← original self-contained reference implementation
docs/                     ← architecture, algorithms, build plan
```

## Deploy
Railway web service (auto-deploy on push to `master`) with a persistent volume at `/app/cache` for the forecast cache. A 6-hourly cron runs `npm run prefetch`. The static marketing page is served from Cloudflare Pages (`site/` output directory, no build step).

## Data sources & attribution
Weather via **Open-Meteo** (GFS / GFS-Wave, CC-BY 4.0) — UI credits **DWD** (data) and **Open-Meteo** (API). Coastline from **GSHHG**.
