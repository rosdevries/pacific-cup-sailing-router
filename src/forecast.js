const TO_KT = { kn: 1, kmh: 0.539957, 'km/h': 0.539957, ms: 1.943844, 'm/s': 1.943844, mph: 0.868976 };

export function bboxFor(pts, m = 3, pole = 4) {
  const la = pts.map(p => p.lat), lo = pts.map(p => p.lon);
  return {
    south: Math.min(...la) - m,
    north: Math.max(...la) + m + pole,
    west:  Math.min(...lo) - m,
    east:  Math.max(...lo) + m,
  };
}

export function buildGrid(b, step) {
  const nLat = Math.max(2, Math.ceil((b.north - b.south) / step) + 1);
  const nLon = Math.max(2, Math.ceil((b.east  - b.west)  / step) + 1);
  const lats = [], lons = [];
  for (let iy = 0; iy < nLat; iy++)
    for (let ix = 0; ix < nLon; ix++) {
      lats.push(+(b.south + iy * step).toFixed(2));
      lons.push(+(b.west  + ix * step).toFixed(2));
    }
  return { lat0: b.south, lon0: b.west, dLat: step, dLon: step, nLat, nLon, nPts: nLat * nLon, lats, lons };
}

export async function omFetch(base, grid, params, signal) {
  // Build the URL manually — URLSearchParams encodes commas as %2C, bloating the
  // lat/lon lists and triggering HTTP 414 on Open-Meteo (multi-point API is GET-only).
  const fixed = [
    `latitude=${grid.lats.join(',')}`,
    `longitude=${grid.lons.join(',')}`,
    'timeformat=unixtime',
    'cell_selection=sea',
    ...Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`),
  ];
  const url = `${base}?${fixed.join('&')}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${base} HTTP ${r.status}`);
  const jx = await r.json();
  return Array.isArray(jx) ? jx : [jx];
}

export async function fetchForecastGrid({ start, dest, step = 1.5, windDays = 14, marineDays = 8, signal } = {}) {
  const grid = buildGrid(bboxFor([start, dest]), step);
  const [wind, marine] = await Promise.all([
    omFetch('https://api.open-meteo.com/v1/forecast', grid,
      { hourly: 'wind_speed_10m,wind_direction_10m,pressure_msl', wind_speed_unit: 'kn', forecast_days: String(windDays) },
      signal),
    omFetch('https://marine-api.open-meteo.com/v1/marine', grid,
      { hourly: 'wave_height,wave_direction,wave_period,swell_wave_direction,ocean_current_velocity,ocean_current_direction', length_unit: 'metric', forecast_days: String(marineDays) },
      signal),
  ]);

  const { nLat, nLon, nPts } = grid;
  const epoch0 = wind[0].hourly.time[0];
  const master  = wind[0].hourly.time;
  const times   = master.map(t => (t - epoch0) / 3600);
  const nT      = times.length;
  const mE      = marine[0].hourly.time;
  const mLast   = mE.length - 1;
  const mAt     = e => Math.max(0, Math.min(mLast, Math.round((e - mE[0]) / 3600)));
  const curK    = TO_KT[marine[0].hourly_units?.ocean_current_velocity] || 1;
  const N = nT * nLat * nLon;
  const F = () => new Float32Array(N);
  const num = v => (v == null || Number.isNaN(v) ? 0 : v);

  const env = {
    epoch0, times,
    lat0: grid.lat0, lon0: grid.lon0, dLat: grid.dLat, dLon: grid.dLon,
    nLat, nLon,
    marineHorizonHours: (mE[mLast] - epoch0) / 3600,
    tws: F(), waveHeight: F(), wavePeriod: F(), curSpeed: F(), pressure: F(),
    twd_x: F(), twd_y: F(), waveDir_x: F(), waveDir_y: F(), curDir_x: F(), curDir_y: F(),
    swellDir_x: F(), swellDir_y: F(),
  };

  const sd = (xa, ya, o, deg) => {
    const d = num(deg) * Math.PI / 180;
    xa[o] = Math.sin(d); ya[o] = Math.cos(d);
  };

  for (let k = 0; k < nPts; k++) {
    const iy = Math.floor(k / nLon), ix = k % nLon;
    const w = wind[k].hourly, m = marine[k].hourly;
    for (let ti = 0; ti < nT; ti++) {
      const o  = (ti * nLat + iy) * nLon + ix;
      const mi = mAt(master[ti]);
      env.tws[o]      = num(w.wind_speed_10m[ti]);
      sd(env.twd_x, env.twd_y, o, w.wind_direction_10m[ti]);
      env.waveHeight[o] = num(m.wave_height[mi]);
      env.wavePeriod[o] = num(m.wave_period[mi]);
      sd(env.waveDir_x, env.waveDir_y, o, m.wave_direction[mi]);
      env.curSpeed[o]   = num(m.ocean_current_velocity[mi]) * curK;
      sd(env.curDir_x, env.curDir_y, o, m.ocean_current_direction[mi]);
      env.pressure[o]   = num(w.pressure_msl[ti]);
      sd(env.swellDir_x, env.swellDir_y, o, m.swell_wave_direction[mi]);
    }
  }
  return env;
}

export function makeSampler(env) {
  const { times, nLat, nLon } = env;
  const idx = (ti, iy, ix) => (ti * nLat + iy) * nLon + ix;
  const bil = (a, ti, iy, ix, fy, fx) => {
    const p = a[idx(ti, iy, ix)]     + (a[idx(ti, iy, ix + 1)]     - a[idx(ti, iy, ix)])     * fx;
    const q = a[idx(ti, iy + 1, ix)] + (a[idx(ti, iy + 1, ix + 1)] - a[idx(ti, iy + 1, ix)]) * fx;
    return p + (q - p) * fy;
  };
  return (lat, lon, t) => {
    const gy = (lat - env.lat0) / env.dLat;
    const gx = (lon - env.lon0) / env.dLon;
    const iy = Math.max(0, Math.min(nLat - 2, Math.floor(gy)));
    const ix = Math.max(0, Math.min(nLon - 2, Math.floor(gx)));
    const fy = Math.min(1, Math.max(0, gy - iy));
    const fx = Math.min(1, Math.max(0, gx - ix));
    let ti = 0;
    while (ti < times.length - 2 && times[ti + 1] < t) ti++;
    const ft = Math.min(1, Math.max(0, (t - times[ti]) / (times[ti + 1] - times[ti])));
    const sc = n => {
      const arr = env[n]; if (!arr) return 0;
      const a = bil(arr, ti, iy, ix, fy, fx), b = bil(arr, ti + 1, iy, ix, fy, fx);
      return a + (b - a) * ft;
    };
    const dr = n => {
      const xa = env[n + '_x'], ya = env[n + '_y'];
      if (!xa || !ya) return 0;
      const ax = bil(xa, ti, iy, ix, fy, fx), ay = bil(ya, ti, iy, ix, fy, fx);
      const bx = bil(xa, ti + 1, iy, ix, fy, fx), by = bil(ya, ti + 1, iy, ix, fy, fx);
      const x = ax + (bx - ax) * ft, y = ay + (by - ay) * ft;
      return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    };
    return {
      tws:        sc('tws'),
      twd:        dr('twd'),
      waveHeight: sc('waveHeight'),
      wavePeriod: sc('wavePeriod'),
      waveDir:    dr('waveDir'),
      swellDir:   dr('swellDir'),
      curSpeed:   sc('curSpeed'),
      curDir:     dr('curDir'),
      pressure:   sc('pressure'),
    };
  };
}

export function expectedCycle() {
  const d = new Date(Date.now() - 5 * 3600e3);
  const h = Math.floor(d.getUTCHours() / 6) * 6;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h) / 1000;
}

export function cycLabel(c) {
  const d = new Date(c * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, timeZoneName: 'short'
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')} ${get('timeZoneName')}`;
}
