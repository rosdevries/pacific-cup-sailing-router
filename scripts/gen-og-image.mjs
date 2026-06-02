/**
 * Generates site/og-image.png — 1200×630 social card.
 * Run once (or after brand updates): node scripts/gen-og-image.mjs
 * Requires: pngjs (already a devDependency)
 */

import { PNG } from 'pngjs';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'site', 'og-image.png');

const W = 1200, H = 630;
const png = new PNG({ width: W, height: H, filterType: -1 });

// ── Colour helpers ──────────────────────────────────────────────────────────

const idx = (x, y) => (y * W + x) * 4;

const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = idx(x, y);
  png.data[i] = r; png.data[i+1] = g; png.data[i+2] = b; png.data[i+3] = a;
};

const blend = (x, y, r, g, b, alpha) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = idx(x, y);
  const t = alpha / 255;
  png.data[i]   = Math.round(png.data[i]   * (1 - t) + r * t);
  png.data[i+1] = Math.round(png.data[i+1] * (1 - t) + g * t);
  png.data[i+2] = Math.round(png.data[i+2] * (1 - t) + b * t);
  png.data[i+3] = 255;
};

// ── Background ──────────────────────────────────────────────────────────────

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Subtle radial gradient from top-left: #0a1c28 → #061019
    const t = Math.min(1, Math.sqrt((x/W)**2 + (y/H)**2) * 1.2);
    const r = Math.round(10  + (6  - 10 ) * t);
    const g = Math.round(28  + (16 - 28 ) * t);
    const b = Math.round(40  + (25 - 40 ) * t);
    set(x, y, r, g, b);
  }
}

// ── Grid lines ──────────────────────────────────────────────────────────────

for (let y = 0; y < H; y += 60) {
  for (let x = 0; x < W; x++) blend(x, y, 63, 205, 224, 14);
}
for (let x = 0; x < W; x += 60) {
  for (let y = 0; y < H; y++) blend(x, y, 63, 205, 224, 14);
}

// ── Drawing primitives ──────────────────────────────────────────────────────

const blendCircleFilled = (cx, cy, r, red, grn, blu, alpha = 255) => {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx*dx + dy*dy <= r*r) blend(cx+dx, cy+dy, red, grn, blu, alpha);
    }
  }
};

const blendCircleOutline = (cx, cy, r, thick, red, grn, blu, alpha) => {
  const r2out = (r + thick) * (r + thick);
  const r2in  = (r - thick) * (r - thick);
  for (let dy = -(r + thick); dy <= (r + thick); dy++) {
    for (let dx = -(r + thick); dx <= (r + thick); dx++) {
      const d2 = dx*dx + dy*dy;
      if (d2 <= r2out && d2 >= r2in) blend(cx+dx, cy+dy, red, grn, blu, alpha);
    }
  }
};

const drawLine = (x1, y1, x2, y2, red, grn, blu, alpha, thick = 2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx*dx + dy*dy);
  const steps = Math.ceil(len * 2);
  const t2 = thick * thick;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x1 + dx * t);
    const y = Math.round(y1 + dy * t);
    for (let ey = -thick; ey <= thick; ey++) {
      for (let ex = -thick; ex <= thick; ex++) {
        if (ex*ex + ey*ey <= t2) blend(x+ex, y+ey, red, grn, blu, alpha);
      }
    }
  }
};

const drawArc = (cx, cy, r, a0, a1, red, grn, blu, alpha, thick = 1) => {
  const steps = Math.ceil(Math.abs(a1 - a0) * r * 2);
  const t2 = thick * thick;
  for (let s = 0; s <= steps; s++) {
    const a = a0 + (a1 - a0) * s / steps;
    const x = Math.round(cx + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * r);
    for (let ey = -thick; ey <= thick; ey++) {
      for (let ex = -thick; ex <= thick; ex++) {
        if (ex*ex + ey*ey <= t2) blend(x+ex, y+ey, red, grn, blu, alpha);
      }
    }
  }
};

// ── Isochrone arcs ──────────────────────────────────────────────────────────
// Origin ~bottom-left; arcs fan northeast toward Hawaii

const ARC_CX = 100, ARC_CY = 520;
const toRad = d => d * Math.PI / 180;
const arcSpan = [toRad(-68), toRad(-8)]; // roughly NE to E

const arcs = [
  { r: 280, alpha: 28 },
  { r: 420, alpha: 24 },
  { r: 580, alpha: 20 },
  { r: 740, alpha: 16 },
  { r: 900, alpha: 12 },
];
for (const { r, alpha } of arcs) {
  drawArc(ARC_CX, ARC_CY, r, arcSpan[0], arcSpan[1], 63, 205, 224, alpha, 1);
}

// ── Compass rose (right side) ────────────────────────────────────────────────

const CC = { x: 920, y: 315 }; // compass centre
const CR = 200;                 // compass radius

blendCircleOutline(CC.x, CC.y, CR,     1, 63, 205, 224, 180);
blendCircleOutline(CC.x, CC.y, CR - 4, 0, 63, 205, 224, 40);
blendCircleOutline(CC.x, CC.y, Math.round(CR * 0.86), 0, 63, 205, 224, 28);

// Cardinal ticks
const tick = (angle, len) => {
  const ax = CC.x + Math.cos(angle) * (CR - 1);
  const ay = CC.y + Math.sin(angle) * (CR - 1);
  const bx = CC.x + Math.cos(angle) * (CR - 1 - len);
  const by = CC.y + Math.sin(angle) * (CR - 1 - len);
  drawLine(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by), 63, 205, 224, 200, 1);
};
for (let deg = 0; deg < 360; deg += 90) tick(toRad(deg - 90), 18);
for (let deg = 45; deg < 360; deg += 90) tick(toRad(deg - 90), 10);

// North marker (amber triangle)
const NX = CC.x, NY = CC.y - CR + 22;
drawLine(NX - 7, NY + 14, NX,    NY,     255, 177, 59, 220, 1);
drawLine(NX,     NY,      NX + 7, NY + 14, 255, 177, 59, 220, 1);
drawLine(NX - 7, NY + 14, NX + 7, NY + 14, 255, 177, 59, 220, 1);
blendCircleFilled(NX, NY + 6, 5, 255, 177, 59, 180);

// Sweep hand (static at ~40°)
const SWEEP_ANGLE = toRad(-50); // pointing NNW
const SX = Math.round(CC.x + Math.cos(SWEEP_ANGLE) * (CR - 2));
const SY = Math.round(CC.y + Math.sin(SWEEP_ANGLE) * (CR - 2));
drawLine(CC.x, CC.y, SX, SY, 63, 205, 224, 200, 1);
blendCircleFilled(SX, SY, 3, 63, 205, 224, 220);

// Small isochrones inside compass
drawArc(CC.x - 65, CC.y, 90,  toRad(-55), toRad(55), 63, 205, 224, 35, 1);
drawArc(CC.x - 45, CC.y, 120, toRad(-50), toRad(50), 63, 205, 224, 28, 1);

// ── Optimal route line across the image ─────────────────────────────────────

const routePts = [
  [140, 500], [220, 462], [330, 416], [460, 368], [600, 318],
  [730, 278], [840, 252], [930, 235],
];
for (let i = 0; i < routePts.length - 1; i++) {
  const [x1, y1] = routePts[i];
  const [x2, y2] = routePts[i + 1];
  drawLine(x1, y1, x2, y2, 255, 177, 59, 210, 3);
}

// Origin dot (SF)
blendCircleFilled(routePts[0][0], routePts[0][1], 7, 255, 177, 59, 230);

// Gybe diamonds
const diamond = (cx, cy) => {
  drawLine(cx, cy - 9, cx + 9, cy, 255, 177, 59, 220, 1);
  drawLine(cx + 9, cy, cx, cy + 9, 255, 177, 59, 220, 1);
  drawLine(cx, cy + 9, cx - 9, cy, 255, 177, 59, 220, 1);
  drawLine(cx - 9, cy, cx, cy - 9, 255, 177, 59, 220, 1);
};
diamond(330, 416);
diamond(600, 318);

// Destination dot (Hawaii direction)
blendCircleFilled(routePts[routePts.length - 1][0], routePts[routePts.length - 1][1], 5, 63, 205, 224, 200);

// ── Left-edge vignette (darkens left margin) ─────────────────────────────────

for (let x = 0; x < 80; x++) {
  const a = Math.round((1 - x / 80) * 140);
  for (let y = 0; y < H; y++) blend(x, y, 6, 16, 25, a);
}

// ── Top/bottom edge lines ────────────────────────────────────────────────────

for (let x = 0; x < W; x++) {
  blend(x, 0,   63, 205, 224, 80);
  blend(x, 1,   63, 205, 224, 40);
  blend(x, H-2, 63, 205, 224, 40);
  blend(x, H-1, 63, 205, 224, 80);
}
for (let y = 0; y < H; y++) {
  blend(0,   y, 63, 205, 224, 80);
  blend(1,   y, 63, 205, 224, 40);
  blend(W-2, y, 63, 205, 224, 40);
  blend(W-1, y, 63, 205, 224, 80);
}

// ── Write PNG ────────────────────────────────────────────────────────────────

const buf = PNG.sync.write(png);
writeFileSync(OUT, buf);
console.log(`og-image.png written → ${OUT} (${(buf.length / 1024).toFixed(0)} KB)`);
