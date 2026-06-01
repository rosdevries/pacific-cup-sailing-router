import { toRad, angDiff } from './geo.js';

export const WAVE = { k: 0.40, a: 1.5, b: 1.0, A: 0.45, B: 0.55, minMult: 0.40, maxMult: 1.08 };

export function waveMult(Hs, T, waveDir, heading) {
  if (!Hs || !T) return 1;
  const beta = toRad(angDiff(waveDir, heading));
  const fA = WAVE.A + WAVE.B * Math.cos(beta);
  const p = WAVE.k * Math.pow(Hs, WAVE.a) * Math.pow(T, -WAVE.b) * fA;
  return Math.min(WAVE.maxMult, Math.max(WAVE.minMult, 1 - p));
}
