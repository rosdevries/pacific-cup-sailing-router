# Architecture

```
            ┌──────────────── Railway service: "router" ────────────────┐
 browser ──▶│  static frontend  +  GET /api/forecast                     │
 (N users)  │        │                    │                              │
            │        │            in-memory cache (by GFS cycle)         │
            │        │                    │  miss → read volume / lazy prefetch
            │        │                    ▼                              │
            │        │            Railway volume  /data/cache/*.json     │◀── persistent
            └────────┼────────────────────┼──────────────────────────────┘
                     │                     ▲
                     │            ┌────────┴─────────┐  6-hourly cron
                     │            │ scripts/prefetch │  (aligned to GFS cycles)
                     │            └────────┬─────────┘
                     ▼                     ▼
              (offline fallback)     Open-Meteo  (forecast + marine APIs)
              synthetic wind field   GFS / GFS-Wave, 6 h cycles
```

## The core idea: cache by model cycle
GFS updates every 6 h (00/06/12/18 UTC). **Within a cycle the forecast is byte-identical**, so
the unit of caching is the *model cycle*, and **one upstream fetch per cycle can serve everyone**.

- The corridor is FIXED (SF → Kaneohe + margin), so a single grid serves every user and every
  re-route within a cycle. Re-routing just re-runs the solver from a new start against the cached
  grid — no new fetch.
- Detect a new cycle with Open-Meteo's **metadata API** (`last_run_availability_time`), which is
  **not counted** against rate limits. Wait ~10 min after availability before fetching.
- Cache key = the cycle's init timestamp. The prototype approximates it client-side as the latest
  00/06/12/18 UTC minus a ~5 h availability lag; the backend should prefer the metadata API.

## Storage decision (GitHub vs Railway volume)
| Data | Where | Why |
|---|---|---|
| `data/boats.json` (polar library) | **GitHub** | static, small, version-controlled |
| `data/corridor-landmask.png` | **GitHub** | static build artifact (~8 KB) |
| `scripts/make-landmask.py` source | **GitHub** | reproducible build input |
| Per-cycle forecast grids (multi-MB, regenerated 4×/day) | **Railway volume** | dynamic, large, transient; never belongs in git |

A Railway **volume** is a persistent disk mounted into the service (e.g. at `/data/cache`); its
contents survive deploys and restarts, so a restart reuses the current cycle's grid instead of
re-fetching. Set `CACHE_DIR` to the mount path. In-memory is the hot path; the volume is the
warm-restart fallback. (Redis would also work but a file on a volume is simpler for this scale.)

## API shape
`GET /api/forecast` → the current corridor grid as JSON (same structure the prototype's
`makeSampler` consumes), e.g.:
```jsonc
{
  "cycle": "2026-06-01T00:00:00Z",   // GFS init time
  "issued": 1780272000,              // epoch0 (unix seconds)
  "lat0": 18.48, "lon0": -160.77, "dLat": 1.5, "dLon": 1.5, "nLat": 19, "nLon": 29,
  "times": [0,1,2, ...],             // hours from issued
  "marineHorizonHours": 192,
  // flat Float32 arrays, index (ti*nLat+iy)*nLon+ix; directions as x/y components:
  "tws": [...], "waveHeight": [...], "wavePeriod": [...], "curSpeed": [...],
  "twd_x": [...], "twd_y": [...], "waveDir_x": [...], "waveDir_y": [...],
  "curDir_x": [...], "curDir_y": [...]
}
```
Serialize the Float32Arrays as plain arrays (or base64) — keep the flat-index layout. Set a
`Cache-Control` matching the cycle TTL and an ETag = cycle so browsers/CDN revalidate cheaply.
Routing (the solver) stays client-side in a Web Worker; the server only serves data.

## Rate-limit math (why this is safe)
- Upstream calls with the cache: 2 endpoints × 4 cycles/day = **~8 calls/day**, independent of
  user count. Free tier is 10,000/day — orders of magnitude of headroom.
- Without caching, server-side: N users × (load + each reroute) all from ONE IP → exhausts the
  daily cap fast (a known failure mode on shared hosts). The cache is what makes a single-IP
  backend viable.

## Compliance
Open-Meteo free tier is **non-commercial** and **CC-BY 4.0**: show attribution to **DWD** (data)
and **Open-Meteo** (API) with a link in the UI. If the app ever adds ads or subscriptions it is
commercial use → subscribe to the customer API (`customer-api.open-meteo.com`, API key,
~€99/mo Standard = 1M calls/mo). For very high scale, self-host an Open-Meteo instance from their
AWS S3 open-data mirror.

## Offline / failure behavior (already in the prototype)
- `/api/forecast` unreachable → frontend falls back to the synthetic North Pacific High field
  (clearly labeled "demo") so the map always renders. Note: synthetic is intentionally idealized
  (steady ~20 kt, no light start/ridge), so it routes optimistically — real GFS is slower.
- Geolocation requires HTTPS; all permission/unavailable/timeout paths degrade gracefully.
