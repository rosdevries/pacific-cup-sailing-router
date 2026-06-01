export const lerp = (a, b, t) => a + (b - a) * t;

export function interp1(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 1;
  while (xs[i] < x) i++;
  return lerp(ys[i - 1], ys[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1]));
}

export function colSpeed(polar, w, twa) {
  const ang = [0, polar.beat.angle[w], ...polar.twa];
  const sp  = [0, polar.beat.speed[w], ...polar.speed.map(r => r[w])];
  return interp1(ang, sp, twa);
}

export function polarSpeed(polar, tws, twaRaw) {
  let twa = ((twaRaw % 360) + 360) % 360;
  if (twa > 180) twa = 360 - twa;
  const T = polar.tws;
  const t = Math.max(T[0], Math.min(T[T.length - 1], tws));
  let w = 1;
  while (w < T.length - 1 && T[w] < t) w++;
  const f = (t - T[w - 1]) / (T[w] - T[w - 1]);
  return lerp(colSpeed(polar, w - 1, twa), colSpeed(polar, w, twa), f);
}
