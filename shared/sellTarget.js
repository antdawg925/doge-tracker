/**
 * Sell target (long) / Cover target (short) for Buy dips / Sell highs.
 * Rule: nearest major level beyond the entry (weekly/monthly pivots, ≥2 touches or a monthly level)
 * that is at least 1 weekly ATR away, capped at 2.5 weekly ATR from the entry so it is realistic
 * inside the hold window. No qualifying level → entry ± 2.5 ATR.
 */
export const TARGET_RULES = Object.freeze({ minAtr: 1, capAtr: 2.5, minTouches: 2 });

export function sellTarget({ side = 'long', entry, levels = [], atrW }) {
  const short = side === 'short';
  if (!(entry > 0) || !(atrW > 0)) return null;
  const minDist = TARGET_RULES.minAtr * atrW;
  const cap = short ? entry - TARGET_RULES.capAtr * atrW : entry + TARGET_RULES.capAtr * atrW;
  const ok = (l) => l && Number.isFinite(l.price) && ((l.touches ?? 0) >= TARGET_RULES.minTouches || l.monthly);
  const beyond = levels
    .filter(ok)
    .filter((l) => (short ? entry - l.price >= minDist : l.price - entry >= minDist))
    .sort((a, b) => (short ? b.price - a.price : a.price - b.price));
  const lvl = beyond[0] || null;
  let price = lvl ? (short ? Math.max(lvl.price, cap) : Math.min(lvl.price, cap)) : cap;
  if (!(price > 0)) return null;
  price = price >= 1 ? Math.round(price * 100) / 100 : Math.round(price * 10000) / 10000;
  const capped = !lvl || price !== (lvl.price >= 1 ? Math.round(lvl.price * 100) / 100 : lvl.price);
  const why = lvl
    ? capped
      ? `${short ? 'Support' : 'Resistance'} ${lvl.price.toFixed(2)} is beyond ${TARGET_RULES.capAtr} ATR; capped`
      : `Nearest major ${short ? 'support' : 'resistance'} (${lvl.touches} touches${lvl.monthly ? ', monthly' : ''})`
    : `No major level ≥1 ATR away; ${TARGET_RULES.capAtr} ATR from entry`;
  return { price, level: lvl?.price ?? null, capped, why };
}
