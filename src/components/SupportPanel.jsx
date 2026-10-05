import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import LevelTable, { InfoTip } from './LevelTable';
import { riskFromHereCopy } from '../lib/levelCopy';
import { distanceToLevel, hasEnteredPosition } from '../lib/math';
import {
  pickTopSupports,
  resolveCoins,
  sellEstimate,
} from '../lib/levels';
import { displaySymbol, unitLabel } from '../lib/assets';

export default function SupportPanel({
  levels,
  spot,
  position,
  asset,
  tfSets,
}) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );
  const { avgCost } = position;
  const hasPos = hasEnteredPosition(coins, avgCost);
  const sym = displaySymbol(asset);
  const units = unitLabel(asset);

  const rows = useMemo(() => {
    const supports = pickTopSupports(levels, spot, tfSets);
    return supports.map((lvl) => {
      const dist = distanceToLevel(spot, lvl.price);
      const est = hasPos
        ? sellEstimate(lvl.price, coins, avgCost, spot)
        : null;
      return { ...lvl, dist, est };
    });
  }, [levels, spot, coins, avgCost, tfSets, hasPos]);

  const info = `Support = prices that have often held as a floor (buyers showed up). Showing the 5 most important levels: nearest structural, short-term, and longer 6M / 1Y / max lows when available. Suggested stops use this same short list. ${
    hasPos
      ? `Dollar risk is vs your average cost for the whole ${sym} holding (what you'd be up or down vs what you paid if that floor hits).`
      : 'No holding entered: showing percent below today only (no made-up dollar amounts).'
  } Hover or tap a row for details.`;

  const table = rows.map((row) => {
    const usdVsCost = row.est?.profitVsCost ?? null;
    const pctVsCost = row.est?.profitPctVsCost ?? null;
    const copy = riskFromHereCopy({ hasPosition: hasPos, usdVsCost, pctVsCost, pctFromSpot: row.dist });
    return {
      id: row.id,
      name: row.friendlyLabel,
      price: formatPrice(row.price),
      pct: row.dist == null ? '—' : formatPct(row.dist, 1),
      pctCls: 'neg',
      usd: hasPos && usdVsCost != null ? formatUsd(usdVsCost, { sign: true, decimals: 0 }) : null,
      usdCls: usdVsCost == null ? 'muted' : usdVsCost >= 0 ? 'pos' : 'neg',
      detail: [row.why, copy],
    };
  });

  return (
    <section className="card lv-card">
      <div className="card__head lv-card__head">
        <h2>
          Support <InfoTip text={info} />
        </h2>
        <span className="muted small">
          Top {rows.length || 5} floors ·{' '}
          {coins > 0 ? `${Math.round(coins).toLocaleString()} ${units}` : `no ${units}`}
        </span>
      </div>

      {!levels?.length && <p className="muted small">Waiting for daily history to compute supports…</p>}

      {levels?.length > 0 && !rows.length && <p className="muted small">No clear supports below spot in this lookback.</p>}

      {table.length > 0 && <LevelTable rows={table} label="Support levels" />}
    </section>
  );
}
