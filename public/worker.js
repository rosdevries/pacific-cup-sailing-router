// Web Worker: route solver. Keeps the map + live marker fluid while computing.
// Receives: { type:'route', origin, dest, polar, polarEff, grid }
//   grid: plain-array env from /api/forecast, or null → use synthetic field
// Posts:   { type:'result', track, hours, isochrones, reached }
//        | { type:'error',  message }

import { route }                                  from '/src/routing.js';
import { makeSampler }                            from '/src/forecast.js';
import { decodePngData, maskLand, legHitsLand }   from '/src/landmask.js';
import { distNm, bearing }                        from '/src/geo.js';

// ---- Synthetic North Pacific High field (offline fallback, matches prototype) ----
const HIGH = { lat: 37, lon: -147 };
function synthEnv(lat, lon) {
  const d   = distNm(HIGH, { lat, lon });
  const brg = bearing(HIGH, { lat, lon });
  const twd = (brg + 270) % 360;
  const tws = Math.min(27, 27 * (1 - Math.exp(-d / 520)));
  return { tws, twd, waveHeight: 0.18 * tws + 0.7, wavePeriod: 5 + tws / 3.5, waveDir: twd, curSpeed: 0.3, curDir: 270 };
}

// ---- Land mask (fetched once, kept in memory) ----
let mask = null;

async function ensureMask() {
  if (mask !== null) return;
  try {
    const resp   = await fetch('/data/corridor-landmask.png');
    const blob   = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const id = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height);
    mask = decodePngData(bitmap.width, bitmap.height, id.data);
  } catch (e) {
    console.warn('[worker] land mask unavailable:', e.message);
    mask = null;
  }
}

// ---- Message handler ----
self.onmessage = async (e) => {
  const { origin, dest, polar, polarEff, grid } = e.data;
  try {
    await ensureMask();
    const sampler = grid
      ? makeSampler(grid)
      : (lat, lon) => synthEnv(lat, lon);
    const lhl = mask
      ? (a, b) => legHitsLand(mask, a, b)
      : () => false;
    const result = route(origin, dest, { sampler, polar, polarEff, legHitsLand: lhl });
    self.postMessage({ type: 'result', ...result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
