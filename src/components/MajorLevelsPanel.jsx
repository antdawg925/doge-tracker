import { useMemo, useState } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { buildMultiTfResistance, resolveCoins } from '../lib/levels';
import { hasEnteredPosition } from '../lib/math';
import LevelTable, { InfoTip } from './LevelTable';

const usd = (n, has) => (has && n != null && Number.isFinite(n) ? formatUsd(n, { sign: true, decimals: 0 }) : null);
const tone = (n) => (n == null ? 'muted' : n >= 0 ? 'pos' : 'neg');
const day = (t) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—');

/**
 * Research levels v2: holding stop + ratchet ladder, 2–3 major supports / resistances
 * (weekly + monthly pivots, see lib/majorLevels.js). Compact rows, details on hover / tap.
 */
export default function MajorLevelsPanel({ major, spot, position, tfSets, source, note = null }) {
  const [showLadder, setShowLadder] = useState(false);
  const coins = useMemo(() => resolveCoins(position, spot), [position, spot]);
  const has = hasEnteredPosition(coins, position.avgCost);
  const { comparison } = useMemo(() => buildMultiTfResistance(tfSets, spot, coins, position.avgCost, position.targetPrice), [tfSets, spot, coins, position.avgCost, position.targetPrice]);

  if (!major) return <p className="muted small">Waiting for weekly history to map the major levels…</p>;
  const atrPct = (major.atrW / spot) * 100;
  const info = `Major levels from ${source === 'weekly' ? `${major.weeks} weekly candles (since ${day(major.since)})` : 'daily history rolled up into weeks'} plus monthly candles: prices where swings reversed more than once, weighted by touches and recency. Levels closer than ${(major.tol * 100).toFixed(0)}% (max of 10% and 1 weekly ATR) are merged. Holding stop = nearest major support minus 1 weekly ATR (${formatPrice(major.atrW)}, ${atrPct.toFixed(1)}%), so normal weekly swings don't hit it. Ladder: when a week closes above a resistance, move the stop up to that level minus 1 weekly ATR. ${has ? 'Dollars are vs your average cost for the whole holding.' : 'No holding entered: percent only.'}`;

  const hs = major.holdingStop;
  const stopRows = [
    ...(hs
      ? [{
          id: 'hold',
          rank: '◆',
          name: 'Holding stop',
          tag: 'main',
          tagCls: 'lvt__tag--main',
          act: hs.under ? `under ${formatPrice(hs.under)}` : '2 wk ATR',
          price: formatPrice(hs.price),
          pct: formatPct(hs.distPct, 1),
          pctCls: 'neg',
          usd: usd(hs.riskVsCost, has),
          usdCls: tone(hs.riskVsCost),
          detail: [`Nearest major support ${hs.under ? formatPrice(hs.under) : '—'} minus 1 weekly ATR (${formatPrice(major.atrW)}).`, has && hs.riskVsCost != null ? `If hit: ${formatUsd(hs.riskVsCost, { sign: true, decimals: 0 })} vs your average cost.` : ''],
        }]
      : []),
    ...major.ladder.map((l, i) => ({
      id: `lad${i}`,
      rank: `↑${i + 1}`,
      name: `Wk close > ${formatPrice(l.trigger)}`,
      act: 'stop to',
      price: formatPrice(l.stop),
      pct: formatPct((l.stop / spot - 1) * 100, 1),
      pctCls: l.stop >= spot ? 'pos' : 'neg',
      usd: usd(l.lockVsCost, has),
      usdCls: tone(l.lockVsCost),
      detail: [`If a week closes above ${formatPrice(l.trigger)}, move the stop to ${formatPrice(l.stop)} (that level minus 1 weekly ATR)${l.stepPct != null ? `: +${l.stepPct.toFixed(1)}% vs the previous stop` : ''}.`, has && l.lockVsCost != null ? `Stop out there: ${formatUsd(l.lockVsCost, { sign: true, decimals: 0 })} vs your average cost.` : ''],
    })),
  ];
  const ladderFor = (price) => major.ladder.find((l) => Math.abs(l.trigger - price) < 1e-12);
  const lvDetail = (l) => `${l.touches} weekly touch${l.touches === 1 ? '' : 'es'}${l.monthly ? ' + monthly pivot' : ''} · last ${day(l.lastT)}`;
  const supRows = major.supports.map((l, i) => ({
    id: `s${i}`,
    rank: `S${i + 1}`,
    name: i === 0 ? 'Major support' : 'Support',
    act: i === 0 ? 'stop goes under' : 'next floor',
    price: formatPrice(l.price),
    pct: formatPct(l.distPct, 1),
    pctCls: 'neg',
    usd: usd(l.usdVsCost, has),
    usdCls: tone(l.usdVsCost),
    detail: [lvDetail(l), i === 0 && hs ? `Holding stop ${formatPrice(hs.price)} sits 1 weekly ATR below.` : 'Next floor if the one above breaks.'],
  }));
  const resRows = major.resistances.map((l, i) => {
    const step = ladderFor(l.price);
    return {
      id: `r${i}`,
      rank: `R${i + 1}`,
      name: i === 0 ? 'Major resistance' : 'Resistance',
      act: step ? `trim · stop → ${formatPrice(step.stop)}` : 'trim',
      tag: null,
      price: formatPrice(l.price),
      pct: formatPct(l.distPct, 1),
      pctCls: 'pos',
      usd: usd(l.usdVsCost, has),
      usdCls: tone(l.usdVsCost),
      detail: [lvDetail(l), `Trim some here.${step ? ` A weekly close above moves the stop to ${formatPrice(step.stop)}.` : ''}`],
    };
  });

  return (
    <div className="mlv">
      {note ? <p className="muted small mlv__note">{note}</p> : null}
      <div className="mlv__stop">
        <span className="mlv__stopline">
          {hs ? (
            <>
              <span className="mlv__stopk">Stop {formatPrice(hs.price)}</span>
              {major.ladder[0] ? (
                <span className="muted">
                  {' '}
                  · raise to <span className="mono">{formatPrice(major.ladder[0].stop)}</span> on a weekly close above <span className="mono">{formatPrice(major.ladder[0].trigger)}</span>
                </span>
              ) : (
                <span className="muted"> · no resistance above to ratchet from yet</span>
              )}
            </>
          ) : (
            <span className="muted">No holding stop: no major support below price.</span>
          )}
          <InfoTip text={info} />
        </span>
        {stopRows.length > 1 ? (
          <button type="button" className="mb-link mlv__toggle small" aria-expanded={showLadder} onClick={() => setShowLadder((v) => !v)}>
            {showLadder ? 'hide ladder' : 'show ladder'}
          </button>
        ) : null}
      </div>
      {showLadder ? <LevelTable rows={stopRows} label="Holding stop and ladder" /> : null}
      <div className="sr-pair mlv__pair">
        <div>
          <h3 className="mlv__h">Support</h3>
          {supRows.length ? <LevelTable rows={supRows} label="Major supports" /> : <p className="muted small">No major support below price.</p>}
        </div>
        <div>
          <h3 className="mlv__h">Resistance</h3>
          {resRows.length ? <LevelTable rows={resRows} label="Major resistances" /> : <p className="muted small">No major resistance above: price is near the top of its range.</p>}
        </div>
      </div>
      {comparison.length > 1 ? (
        <details className="mlv__more">
          <summary className="small muted">Period highs (6M / 1Y / max)</summary>
          <table className="mlv__tbl small">
            <tbody>
              {comparison.map((row) => (
                <tr key={row.key}>
                  <td>{row.shortLabel}</td>
                  <td className="mono">{formatPrice(row.price)}</td>
                  <td className={row.aboveSpot ? 'pos mono' : 'muted mono'}>{formatPct(row.distPct, 1)}</td>
                  <td className="mono">{row.aboveSpot && has && row.upsideVsCost != null ? formatUsd(row.upsideVsCost, { sign: true, decimals: 0 }) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}
