import { distNm, bearing, gcProject, vec, brgOf, angDiff } from './geo.js';
import { polarSpeed } from './polar.js';
import { waveMult } from './waves.js';

export function boatStep(node, h, dt, { sampler, polar, polarEff }) {
  const e = sampler(node.lat, node.lon, node.t);
  const stw = polarSpeed(polar, e.tws, angDiff(e.twd, h))
            * waveMult(e.waveHeight, e.wavePeriod, e.waveDir, h)
            * polarEff;
  if (!(stw > 0)) return null;
  const boat = vec(h, stw), cur = vec(e.curDir, e.curSpeed);
  const sx = boat.x + cur.x, sy = boat.y + cur.y, sog = Math.hypot(sx, sy);
  const p = gcProject(node, brgOf(sx, sy), sog * dt);
  return { lat: p.lat, lon: p.lon, t: node.t + dt, parent: node };
}

export function prune(c, start, sec) {
  const best = new Map();
  for (const n of c) {
    const key = Math.round(bearing(start, n) / sec);
    const d = distNm(start, n), cur = best.get(key);
    if (!cur || d > cur._d) { n._d = d; best.set(key, n); }
  }
  return [...best.values()];
}

export function backtrack(n) {
  const p = [];
  for (; n; n = n.parent) p.push({ lat: n.lat, lon: n.lon, t: n.t });
  return p.reverse();
}

// sampler: (lat, lon, t) → { tws, twd, waveHeight, wavePeriod, waveDir, curSpeed, curDir }
// legHitsLand: (a, b) → boolean
export function route(start, dest, { sampler, polar, polarEff, legHitsLand }) {
  const dt = 3, hStep = 8, sec = 2, maxH = 384, maxSog = 16;
  let front = [{ lat: start.lat, lon: start.lon, t: 0, parent: null }];
  const isochrones = [];

  for (let el = 0; el < maxH; el += dt) {
    const cands = [];
    let finish = null;

    for (const node of front) {
      for (let h = 0; h < 360; h += hStep) {
        const nn = boatStep(node, h, dt, { sampler, polar, polarEff });
        if (!nn) continue;
        if (legHitsLand(node, nn)) continue;
        cands.push(nn);
        if (distNm(nn, dest) <= dt * maxSog && !legHitsLand(nn, dest) && (!finish || nn.t < finish.t))
          finish = nn;
      }
    }

    if (finish) {
      isochrones.push(front);
      const fe   = sampler(finish.lat, finish.lon, finish.t);
      const fh   = bearing(finish, dest);
      const fstw = polarSpeed(polar, fe.tws, angDiff(fe.twd, fh))
                 * waveMult(fe.waveHeight, fe.wavePeriod, fe.waveDir, fh)
                 * polarEff;
      const fb = vec(fh, fstw), fc = vec(fe.curDir, fe.curSpeed);
      const fsog = Math.hypot(fb.x + fc.x, fb.y + fc.y);
      const legT = fsog > 0 ? distNm(finish, dest) / fsog : distNm(finish, dest) / maxSog;
      const dst = { lat: dest.lat, lon: dest.lon, t: finish.t + legT, parent: finish };
      return { track: backtrack(dst), hours: dst.t, isochrones, reached: true };
    }

    front = prune(cands, start, sec);
    isochrones.push(front);
    if (!front.length) break;
  }

  let best = null, bd = 1e9;
  for (const n of front) { const d = distNm(n, dest); if (d < bd) { bd = d; best = n; } }
  return { track: best ? backtrack(best) : [], hours: best ? best.t : 0, isochrones, reached: false };
}
