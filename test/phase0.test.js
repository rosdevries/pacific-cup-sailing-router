import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

import { makeSampler } from '../src/forecast.js';
import { route } from '../src/routing.js';
import { decodePngData, maskLand, legHitsLand } from '../src/landmask.js';
import { distNm, bearing } from '../src/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- SC40 polar ----
const { boats } = JSON.parse(readFileSync(join(ROOT, 'data/boats.json'), 'utf8'));
const sc40 = boats.sc40.polar;

// ---- Synthetic North Pacific High field (matches prototype §environment) ----
const HIGH = { lat: 37, lon: -147 };
function synthEnv(lat, lon) {
  const d   = distNm(HIGH, { lat, lon });
  const brg = bearing(HIGH, { lat, lon });
  const twd = (brg + 270) % 360;
  const tws = Math.min(27, 27 * (1 - Math.exp(-d / 520)));
  return { tws, twd, waveHeight: 0.18 * tws + 0.7, wavePeriod: 5 + tws / 3.5, waveDir: twd, curSpeed: 0.3, curDir: 270 };
}
const synthSampler = (lat, lon) => synthEnv(lat, lon);

// ---- Land mask ----
let mask = null;
try {
  const buf = readFileSync(join(ROOT, 'data/corridor-landmask.png'));
  const png = PNG.sync.read(buf);
  mask = decodePngData(png.width, png.height, png.data);
} catch {
  console.warn('[tests] Land mask unavailable — land-check tests will be skipped');
}

const lhl = mask ? (a, b) => legHitsLand(mask, a, b) : () => false;

const SF   = { lat: 37.8197, lon: -122.4786  }; // Golden Gate / Pac Cup start
const DEST = { lat: 21.4806, lon: -157.7725 };

// ============================================================
// Test 1: direction interpolation — 350° and 10° must average to 0°, not 180°
// ============================================================
test('direction interpolation: 350° and 10° average to 0°', () => {
  const nLat = 2, nLon = 2, nT = 2;
  const N = nT * nLat * nLon;
  const env = {
    epoch0: 0, times: [0, 3],
    lat0: 20, lon0: -155, dLat: 1, dLon: 1,
    nLat, nLon,
    marineHorizonHours: 192,
    tws:        new Float32Array(N).fill(15),
    waveHeight: new Float32Array(N).fill(0),
    wavePeriod: new Float32Array(N).fill(0),
    curSpeed:   new Float32Array(N).fill(0),
    twd_x:    new Float32Array(N), twd_y:    new Float32Array(N),
    waveDir_x: new Float32Array(N).fill(0), waveDir_y: new Float32Array(N).fill(1),
    curDir_x:  new Float32Array(N).fill(0), curDir_y:  new Float32Array(N).fill(1),
  };

  const d350 = 350 * Math.PI / 180;
  const d10  =  10 * Math.PI / 180;
  const idx  = (ti, iy, ix) => (ti * nLat + iy) * nLon + ix;

  for (let ti = 0; ti < nT; ti++) {
    for (let iy = 0; iy < nLat; iy++) {
      const o0 = idx(ti, iy, 0); env.twd_x[o0] = Math.sin(d350); env.twd_y[o0] = Math.cos(d350);
      const o1 = idx(ti, iy, 1); env.twd_x[o1] = Math.sin(d10);  env.twd_y[o1] = Math.cos(d10);
    }
  }

  const sampler = makeSampler(env);
  const result  = sampler(20.5, -154.5, 0);   // fx = 0.5, midpoint between ix=0 and ix=1
  // angular distance from 0° — should be < 1°
  const diff = Math.abs(((result.twd % 360) + 360) % 360);
  const angularDist = Math.min(diff, 360 - diff);
  assert.ok(angularDist < 1, `Expected twd ≈ 0°, got ${result.twd.toFixed(2)}°`);
});

// ============================================================
// Tests 2a–c: polar efficiency scales passage time as ~1/η
// ============================================================
const effCases = [
  { eff: 1.00, minD: 8.4, maxD: 9.4, label: '~8.9d' },
  { eff: 0.90, minD: 9.3, maxD: 10.3, label: '~9.8d' },
  { eff: 0.85, minD: 9.8, maxD: 10.8, label: '~10.3d' },
];

for (const { eff, minD, maxD, label } of effCases) {
  test(`SC40 polar efficiency ${eff} → passage ${label}`, { timeout: 30_000 }, () => {
    const result = route(SF, DEST, { sampler: synthSampler, polar: sc40, polarEff: eff, legHitsLand: lhl });
    assert.ok(result.reached, `Route with eff=${eff} should reach Kaneohe`);
    const days = result.hours / 24;
    assert.ok(
      days >= minD && days <= maxD,
      `eff=${eff}: expected ${minD}–${maxD} days, got ${days.toFixed(2)}`,
    );
  });
}

// ============================================================
// Test 3: route reaches Kaneohe and no track leg crosses land
// ============================================================
test(
  'SC40 synthetic route: reaches Kaneohe with 0 track legs on land',
  { skip: mask == null ? 'land mask not available' : false, timeout: 30_000 },
  () => {
    const checkLhl = (a, b) => legHitsLand(mask, a, b);
    const result   = route(SF, DEST, { sampler: synthSampler, polar: sc40, polarEff: 0.90, legHitsLand: checkLhl });
    assert.ok(result.reached, 'Route should reach Kaneohe');
    const track = result.track;
    for (let i = 0; i < track.length - 1; i++) {
      assert.ok(!checkLhl(track[i], track[i + 1]), `Track leg ${i} crosses land`);
    }
  },
);
