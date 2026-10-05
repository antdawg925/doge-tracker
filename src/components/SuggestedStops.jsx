import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import LevelTable, { InfoTip } from './LevelTable';
import { riskFromHereCopy } from '../lib/levelCopy';
import { hasEnteredPosition } from '../lib/math';
import { resolveCoins, suggestStops } from '../lib/levels';

export default function SuggestedStops({ levels, spot, position, tfSets }) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );
  const hasPos = hasEnteredPosition(coins, position.avgCost);

  const { candidates, primaryId } = useMemo(
    () => suggestStops(levels, spot, coins, position.avgCost, tfSets),
    [levels, spot, coins, position.avgCost, tfSets],
  );

  const info = `A stop is the price where you'd cut the trade if it breaks down, so a small loss doesn't become a big one. These ideas use the same condensed Top supports as the Support panel, not every statistical floor. ${
    hasPos
      ? 'Risk dollars are vs your average cost for the whole position (P&L if stopped out there vs what you paid).'
      : 'No holding entered: showing percent below today only (no made-up dollar amounts).'
  } "main" = recommended: closest meaningful support (ideally ~3–5% below spot so everyday noise doesn't stop you out). Hover or tap a row for details.`;

  const table = candidates.map((s) => {
    const isPrimary = s.id === primaryId;
    const usdVsCost = hasPos ? s.riskVsCost : null;
    const pctVsCost =
      hasPos && usdVsCost != null && Number.isFinite(coins) && coins > 0 && Number.isFinite(position.avgCost) && position.avgCost > 0
        ? (usdVsCost / (coins * position.avgCost)) * 100
        : null;
    const copy = riskFromHereCopy({ hasPosition: hasPos, usdVsCost, pctVsCost, pctFromSpot: -s.distPctBelow });
    return {
      id: s.id,
      name: String(s.label || '').replace(/\s*\(.*\)\s*$/, '') || s.label,
      tag: isPrimary ? 'main' : null,
      tagCls: 'lvt__tag--main',
      price: formatPrice(s.price),
      pct: formatPct(-s.distPctBelow, 1),
      pctCls: 'neg',
      usd: hasPos && usdVsCost != null ? formatUsd(usdVsCost, { sign: true, decimals: 0 }) : null,
      usdCls: usdVsCost == null ? 'muted' : usdVsCost >= 0 ? 'pos' : 'neg',
      detail: [/\(/.test(s.label || '') ? `${s.label} · ${s.name}` : s.name, s.why, copy, isPrimary ? 'Recommended: closest meaningful support (ideally ~3–5% below spot so everyday noise doesn’t stop you out).' : ''],
    };
  });

  return (
    <section className="card lv-card">
      <div className="card__head lv-card__head">
        <h2>
          Suggested stop losses <InfoTip text={info} />
        </h2>
        <span className="muted small">Aligned with Top support floors</span>
      </div>

      {!spot && <p className="muted small">Waiting for live spot to suggest stops…</p>}

      {spot && !candidates.length && (
        <p className="muted small">No clear support below spot yet: wait for more daily history, or check the Support panel.</p>
      )}

      {table.length > 0 && <LevelTable rows={table} label="Suggested stops" />}
    </section>
  );
}
