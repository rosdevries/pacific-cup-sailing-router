import { distNm } from './geo.js';

// Bounding box the corridor-landmask.png covers. Matches VIEW in the prototype.
export const VIEW = { latMin: 16, latMax: 42.5, lonMin: -160.5, lonMax: -116 };

// Convert raw RGBA pixel buffer (4 bytes per pixel) into a { nx, ny, data } mask.
// Works identically whether the buffer comes from Canvas getImageData or from pngjs.
export function decodePngData(width, height, rgbaData) {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    data[i] = rgbaData[i * 4] > 127 ? 1 : 0;
  }
  return { nx: width, ny: height, data };
}

export function maskLand(mask, lat, lon) {
  if (!mask) return false;
  const ix = Math.floor((lon - VIEW.lonMin) / (VIEW.lonMax - VIEW.lonMin) * mask.nx);
  const iy = Math.floor((VIEW.latMax - lat) / (VIEW.latMax - VIEW.latMin) * mask.ny);
  if (ix < 0 || iy < 0 || ix >= mask.nx || iy >= mask.ny) return false;
  return mask.data[iy * mask.nx + ix] === 1;
}

// Sample the leg at ~1 nm intervals (mask resolution), not just endpoints.
export function legHitsLand(mask, a, b) {
  const steps = Math.max(2, Math.ceil(distNm(a, b)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (maskLand(mask, a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t)) return true;
  }
  return false;
}
