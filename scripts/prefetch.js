// Fetch the current GFS cycle's corridor grid and write it to the cache.
// Run on a 6 h Railway cron (~15 min after each cycle) and once on deploy.
// Idempotent: skips if the cycle is already cached.
//
// Does NOT import server/index.js — that module starts an HTTP server as a
// side effect which would prevent this script from ever exiting cleanly.

import { writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchForecastGrid } from '../src/forecast.js';

const ROOT      = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, '.cache');

const SF         = { lat: 37.60,   lon: -122.90   };
const SAN_PEDRO  = { lat: 33.6917, lon: -118.2917 };
const DEST       = { lat: 21.4806, lon: -157.7725 };
const GRID_START = { lat: SF.lat, lon: SAN_PEDRO.lon };

async function metadataLatestCycle() {
  const url = 'https://api.open-meteo.com/data/ecmwf?variables=&models=gfs_seamless';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const j = await r.json();
      const ts = j?.last_run_availability_time;
      if (ts) {
        const t = Math.floor(new Date(ts).getTime() / 1000);
        if (t > 0) return t;
      }
    }
  } catch { /* fall through */ }
  const d = new Date(Date.now() - 5 * 3600e3);
  const h = Math.floor(d.getUTCHours() / 6) * 6;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h) / 1000;
}

async function main() {
  const cycle = await metadataLatestCycle();
  const file  = path.join(CACHE_DIR, `forecast-${cycle}.json`);

  try {
    await access(file);
    console.log(`[prefetch] cycle ${new Date(cycle * 1000).toISOString()} already cached — nothing to do`);
    return;
  } catch { /* not cached yet, continue */ }

  console.log(`[prefetch] fetching cycle ${new Date(cycle * 1000).toISOString()} → ${CACHE_DIR}`);
  const raw  = await fetchForecastGrid({ start: GRID_START, dest: DEST, step: 1.5 });
  const grid = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v instanceof Float32Array ? Array.from(v) : v]),
  );
  grid.cycle = new Date(cycle * 1000).toISOString();
  const payload = JSON.stringify(grid);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `forecast-${cycle}.json`), payload);
  await writeFile(path.join(CACHE_DIR, 'latest.json'), payload);
  console.log(`[prefetch] cached ${grid.nLat}×${grid.nLon} grid, ${grid.times.length} forecast frames`);
}

main().catch(e => { console.error('[prefetch] failed:', e.message); process.exit(1); });
