/** Kraken public-API parsing (pure). Shared by the browser and the server bot. */

/**
 * Normalize Kraken OHLC rows:
 * `[time, open, high, low, close, vwap, volume, count]`
 * where `time` is unix **seconds** into chart bars (`t` in ms).
 */
export function normalizeKrakenOhlc(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 5) return null;
      const [timeSec, openRaw, highRaw, lowRaw, closeRaw, , volumeRaw] = row;
      const close = Number(closeRaw);
      const open = Number(openRaw);
      const high = Number(highRaw);
      const low = Number(lowRaw);
      const volume = Number(volumeRaw);
      if (!Number.isFinite(close) || !Number.isFinite(timeSec)) return null;
      const t = Number(timeSec) * 1000;
      return {
        t,
        date: new Date(t).toISOString().slice(0, 10),
        open: Number.isFinite(open) ? open : close,
        high: Number.isFinite(high) ? high : close,
        low: Number.isFinite(low) ? low : close,
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

export function pickKrakenPairRows(result) {
  if (!result || typeof result !== 'object') return null;
  for (const [key, value] of Object.entries(result)) {
    if (key === 'last') continue;
    if (Array.isArray(value)) return value;
  }
  return null;
}

/** First pair row of a public Ticker result → { price, open, change24h } or null. */
export function pickKrakenTicker(result) {
  if (!result || typeof result !== 'object') return null;
  for (const [key, value] of Object.entries(result)) {
    if (key === 'last' || !value || typeof value !== 'object') continue;
    const price = Number(Array.isArray(value.c) ? value.c[0] : value.c);
    const open = Number(value.o);
    if (!Number.isFinite(price)) return null;
    return {
      price,
      open: Number.isFinite(open) ? open : null,
      change24h: Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : null,
    };
  }
  return null;
}
