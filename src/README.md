# `src/` — extracted core (Phase 0)

Pure, framework-agnostic modules lifted from `prototype/router-demo.html` so the same logic runs
in the browser (Web Worker) and in Node (prefetch). No DOM, no `fetch` side-effects in here except
`forecast.js`'s network helpers (which take a `fetch` and work in both environments).

Planned files (see `docs/BUILD_PLAN.md` Phase 0 and `docs/ALGORITHMS.md` for the exact code):

- `geo.js` — `toRad, distNm, bearing, gcProject, vec, brgOf, angDiff`
- `polar.js` — schema + `interp1, colSpeed, polarSpeed`
- `waves.js` — `WAVE` params + `waveMult`
- `routing.js` — `boatStep, prune, backtrack, route` (inject `{sampler, polar, polarEff, landMask}`)
- `forecast.js` — `bboxFor, buildGrid, omFetch, fetchForecastGrid, makeSampler, expectedCycle, cycLabel`
- `landmask.js` — PNG → `Uint8` grid, `maskLand, legHitsLand`
- `orrParse.js` — `linesFromContent, nums, parseORR` (browser-only; consumes pdf.js text items)

Keep behavior identical to the prototype — the Phase 0 tests assert the prototype's validated
numbers (passage times, parser output, direction interpolation).
