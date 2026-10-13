/** Compact average dollar volume: 85_000_000 → "$85M/day", 1.2e9 → "$1.2B/day". */
export function dollarVolLabel(v) {
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B/day`;
  return `$${Math.round(v / 1e6)}M/day`;
}
