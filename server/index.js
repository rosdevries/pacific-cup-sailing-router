import http from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchForecastGrid } from '../src/forecast.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const PORT       = process.env.PORT       || 3000;
const CACHE_DIR  = process.env.CACHE_DIR  || path.join(ROOT, '.cache');
const STATIC_DIR = process.env.STATIC_DIR || path.join(ROOT, 'public');

console.log('[server] starting — PORT:', PORT, 'CACHE_DIR:', CACHE_DIR, 'ROOT:', ROOT);

const SF   = { lat: 37.60,   lon: -122.90   };
const DEST = { lat: 21.4806, lon: -157.7725 };

let mem      = null;   // { cycle, grid } hot-path cache
let inflight = null;   // de-dupe concurrent lazy prefetch (prevents upstream stampede)

// ---- GFS cycle detection ----------------------------------------

// Open-Meteo metadata API: returns the init time of the latest available GFS cycle.
// This endpoint is NOT counted against rate limits.
async function metadataLatestCycle() {
  const url = 'https://api.open-meteo.com/data/ecmwf?variables=&models=gfs_seamless';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      // last_run_availability_time is an ISO timestamp; parse to unix seconds
      const ts = j?.last_run_availability_time;
      if (ts) {
        const t = Math.floor(new Date(ts).getTime() / 1000);
        if (t > 0) return t;
      }
    }
  } catch { /* fall through to approximation */ }
  // Fallback: approximate from wall clock (6 h cadence, ~5 h availability lag)
  const d = new Date(Date.now() - 5 * 3600e3);
  const h = Math.floor(d.getUTCHours() / 6) * 6;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h) / 1000;
}

// ---- Cache read / write -----------------------------------------

async function loadCachedGrid(cycle) {
  if (mem && mem.cycle === cycle) return mem.grid;   // hot
  try {
    const buf = await readFile(path.join(CACHE_DIR, `forecast-${cycle}.json`), 'utf8');
    const grid = JSON.parse(buf);
    mem = { cycle, grid };
    return grid;
  } catch { return null; }
}

export async function refreshCache(cycle) {
  const raw  = await fetchForecastGrid({ start: SF, dest: DEST, step: 1.5 });
  // Flatten Float32Arrays → plain arrays for JSON storage (typed arrays don't survive JSON.stringify).
  // Keep the plain-array version in mem so both cache paths return the same shape.
  const grid = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v instanceof Float32Array ? Array.from(v) : v]),
  );
  grid.cycle = new Date(cycle * 1000).toISOString();
  const payload = JSON.stringify(grid);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `forecast-${cycle}.json`), payload);
  await writeFile(path.join(CACHE_DIR, 'latest.json'), payload);
  mem = { cycle, grid };
  return grid;
}

async function getGrid() {
  const cycle = await metadataLatestCycle();
  const cached = await loadCachedGrid(cycle);
  if (cached) return cached;
  // Lazy prefetch — de-duped so N concurrent requests make exactly 1 upstream call
  if (!inflight) inflight = refreshCache(cycle).finally(() => { inflight = null; });
  return inflight;
}

// ---- Static file serving ----------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// Resolve a URL pathname to a filesystem path.
// /src/* and /data/* come from the project root; everything else from STATIC_DIR.
function resolveFile(pathname) {
  const p = path.posix.normalize(pathname);
  if (p.startsWith('/src/'))  return path.join(ROOT, 'src',  path.normalize(p.slice(5)));
  if (p.startsWith('/data/')) return path.join(ROOT, 'data', path.normalize(p.slice(6)));
  const rel = p === '/' ? 'index.html' : p.slice(1) || 'index.html';
  return path.join(STATIC_DIR, path.normalize(rel));
}

// Allowlist: only src/, data/, and public/ are browser-accessible.
function isAllowed(file) {
  return (
    file.startsWith(path.join(ROOT, 'src')  + path.sep) ||
    file.startsWith(path.join(ROOT, 'data') + path.sep) ||
    file.startsWith(STATIC_DIR + path.sep)              ||
    file === path.join(STATIC_DIR, 'index.html')
  );
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolveFile(pathname);
  if (!isAllowed(file)) { res.writeHead(403); res.end('forbidden'); return; }
  try { await access(file); } catch { res.writeHead(404); res.end('not found'); return; }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

// ---- HTTP server ------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/forecast') {
      const grid = await getGrid();   // plain-array grid (Float32Arrays flattened in refreshCache)
      const body = JSON.stringify(grid);
      res.writeHead(200, {
        'content-type':  'application/json',
        'cache-control': 'public, max-age=600',
        'etag':          `"${grid.cycle}"`,
      });
      return res.end(body);
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    await serveStatic(req, res);
  } catch (e) {
    console.error('[server]', e.message);
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

server.on('error', e => { console.error('[server] listen error:', e.message, 'PORT:', PORT); process.exit(1); });
server.listen(PORT, () => {
  console.log(`Pacific Cup Sailing Router on :${PORT}`);
  // Background GFS refresh: poll every 30 min so a new cycle is cached as soon
  // as it's available (~5 h after cycle init) without needing a separate cron service.
  setInterval(() => {
    getGrid().catch(e => console.error('[server] bg refresh failed:', e.message));
  }, 30 * 60 * 1000);
});
