export function formatUsd(n, opts = {}) {
  if (n == null || Number.isNaN(n)) return '—';
  const { decimals, sign = false } = opts;

  const abs = Math.abs(n);
  let maxFrac = decimals;
  if (maxFrac == null) {
    if (abs >= 1000) maxFrac = 0;
    else if (abs >= 1) maxFrac = 2;
    else if (abs >= 0.01) maxFrac = 4;
    else maxFrac = 6;
  }

  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: maxFrac,
    maximumFractionDigits: maxFrac,
  }).format(n);

  if (sign && n > 0) return `+${formatted}`;
  return formatted;
}

export function formatPct(n, decimals = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

export function formatCoins(n, decimals = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(n);
}

export function formatPrice(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 100) return formatUsd(n, { decimals: 2 });
  if (n >= 1) return formatUsd(n, { decimals: 2 });
  if (n >= 0.1) return formatUsd(n, { decimals: 3 });
  return formatUsd(n, { decimals: 4 });
}

export function formatTime(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(ts);
}

/** Compact volume for dad-friendly metrics (e.g. 1.2M, 45.3K). */
export function formatVolume(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 10) return `${sign}${abs.toFixed(0)}`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(4)}`;
}
