// Browser-only: consumes pdf.js text items from getTextContent().
// Reconstruct visual text rows by clustering items by y (within 3 pt), ordering by x.
export function linesFromContent(items) {
  const its = items
    .map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str }))
    .filter(it => it.s.trim());
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const out = [];
  let cur = null;
  for (const it of its) {
    if (!cur || Math.abs(it.y - cur.y) > 3) { cur = { y: it.y, parts: [] }; out.push(cur); }
    cur.parts.push(it);
  }
  return out.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' '));
}

export function nums(s) {
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
  return m ? m.map(Number) : [];
}

// Parse the FIRST "Table of Boat Speed Polars" (page 2 boat polar).
// Do NOT take the page-3 fleet-adjusted copy — the table break stops us.
export function parseORR(lines) {
  let i = lines.findIndex(l => /Table of Boat Speed Polars/i.test(l));
  if (i < 0) throw new Error('No “Table of Boat Speed Polars” found — is this an ORR certificate?');

  let tws = null, beatA = null, beatS = null;
  const twa = [], speed = [];

  for (let j = i + 1; j < lines.length; j++) {
    const L = lines[j];
    if (/Table of (Time Allowances|Boat Speed Polars)/i.test(L)) break;
    if (/True Wind Speed/i.test(L))    { tws  = nums(L); continue; }
    if (/Up Angle/i.test(L))           { beatA = nums(L); continue; }
    if (/Speed\s*Up\s*kts/i.test(L))  { beatS = nums(L); continue; }
    if (/Speed\s*Dn\s*kts|Dn Angle/i.test(L)) continue;
    const m = L.match(/^\s*(\d{2,3})\s*°/);
    if (m) { const v = nums(L); if (v.length >= 2) { twa.push(+m[1]); speed.push(v.slice(1)); } }
  }

  if (!tws || !beatA || !beatS)
    throw new Error('Could not read the wind / angle / speed header rows');
  const n = tws.length;
  if (beatA.length !== n || beatS.length !== n)
    throw new Error(`Up-angle columns (${beatA.length}) do not match wind speeds (${n})`);
  if (twa.length < 4)
    throw new Error(`Only ${twa.length} wind-angle rows found`);
  const speedN = speed.map(r => r.slice(0, n));
  if (speedN.some(r => r.length !== n))
    throw new Error('A speed row has the wrong number of columns');

  return { tws, twa, speed: speedN, beat: { angle: beatA, speed: beatS } };
}
