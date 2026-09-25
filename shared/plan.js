/**
 * DOGE plan model (pure): defaults, normalization, stop-rules version.
 * Shared by the browser (src/lib/planStore.js) and the server bot (api/_botRunner.js).
 */

/** Bump whenever stop rules change so stale ratchet memory is recomputed, not trusted. */
export const STOP_RULES_VERSION = 2;
export const DEFAULT_PLAN = Object.freeze({
  symbol: 'DOGE',
  pair: 'XDGUSD',
  avgCost: 0.075,
  corePct: 78,
  slicePct: 22,
  sellLevel: 0.1,
  buyBackLevel: 0.087,
  stopFloor: 0.079,
  breakoutLevel: 0.104,
  breakoutFloor: 0.09,
  highZone: Object.freeze({ low: 0.11, high: 0.117 }),
  lowZone: Object.freeze({ low: 0.085, high: 0.09 }),
  atrMult: 2.5,
  tightMult: 1.75,
  tightenPct: 15,
  tightenRef: null,
  anchorAt: null,
  note: '',
  updatedAt: null,
});

const num = (v, fallback) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) && n > 0 ? n : null;
};

function zone(z, d) {
  const low = num(z?.low, d.low);
  const high = num(z?.high, d.high);
  return low <= high ? { low, high } : { low: high, high: low };
}

export function normalizePlan(p = {}) {
  const d = DEFAULT_PLAN;
  return {
    symbol: 'DOGE',
    pair: typeof p.pair === 'string' && p.pair ? p.pair : d.pair,
    avgCost: num(p.avgCost, d.avgCost),
    corePct: num(p.corePct, d.corePct),
    slicePct: num(p.slicePct, d.slicePct),
    sellLevel: num(p.sellLevel, d.sellLevel),
    buyBackLevel: num(p.buyBackLevel, d.buyBackLevel),
    stopFloor: num(p.stopFloor, d.stopFloor),
    breakoutLevel: num(p.breakoutLevel, d.breakoutLevel),
    breakoutFloor: num(p.breakoutFloor, d.breakoutFloor),
    highZone: zone(p.highZone, d.highZone),
    lowZone: zone(p.lowZone, d.lowZone),
    atrMult: num(p.atrMult, d.atrMult),
    tightMult: num(p.tightMult, d.tightMult),
    tightenPct: num(p.tightenPct, d.tightenPct),
    tightenRef: numOrNull(p.tightenRef),
    anchorAt:
      typeof p.anchorAt === 'string' && !Number.isNaN(Date.parse(p.anchorAt))
        ? p.anchorAt
        : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(),
    note: typeof p.note === 'string' ? p.note.slice(0, 2000) : '',
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
  };
}
