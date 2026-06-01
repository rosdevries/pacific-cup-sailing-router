export const R_NM = 3440.065;
export const toRad = d => d * Math.PI / 180;
export const toDeg = r => r * 180 / Math.PI;

export function distNm(a, b) {
  const f1 = toRad(a.lat), f2 = toRad(b.lat);
  const df = toRad(b.lat - a.lat), dl = toRad(b.lon - a.lon);
  const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const f1 = toRad(a.lat), f2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function gcProject(a, brg, d) {
  const dr = d / R_NM, th = toRad(brg), f1 = toRad(a.lat), l1 = toRad(a.lon);
  const f2 = Math.asin(Math.sin(f1) * Math.cos(dr) + Math.cos(f1) * Math.sin(dr) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dr) * Math.cos(f1), Math.cos(dr) - Math.sin(f1) * Math.sin(f2));
  return { lat: toDeg(f2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

export const vec = (b, s) => ({ x: Math.sin(toRad(b)) * s, y: Math.cos(toRad(b)) * s });
export const brgOf = (x, y) => (toDeg(Math.atan2(x, y)) + 360) % 360;
export const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
