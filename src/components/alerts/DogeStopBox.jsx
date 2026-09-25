import { formatPct, formatPrice, formatUsd } from '../../lib/format.js';

const fmtAtr = (n) => formatUsd(n, { decimals: 5 });

const pctFrom = (price, level) => (price && level ? ((level - price) / price) * 100 : null);
const fmtWhen = (t) =>
  t
    ? new Date(t).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const SOURCE_COPY = {
  floor: 'manual floor',
  breakoutFloor: 'floor after breakout',
  trail: 'ATR trail',
  ratchet: 'ratchet (held from an earlier, higher stop)',
};

function Stat({ label, value, sub, tone }) {
  return (
    <div className="dp-stat">
      <dt>{label}</dt>
      <dd className={`mono ${tone || ''}`}>{value}</dd>
      {sub ? <dd className="dp-stat__sub muted small">{sub}</dd> : null}
    </div>
  );
}

export default function DogeStopBox({ plan, snapshot: s, market, onResetTrail, onRaiseFloor }) {
  if (!s) {
    return (
      <section className="card dp-stop">
        <div className="card__head">
          <h2>Live stop</h2>
        </div>
        <p className="muted">
          {market.error ? `Kraken data unavailable: ${market.error}` : 'Loading Kraken 4h candles…'}
        </p>
      </section>
    );
  }

  const volRatio = s.medianAtrPct ? s.atrPct / s.medianAtrPct : null;
  const stage2 = s.stage === 2;
  // Stage 2 already applies the breakout floor automatically; this just lets
  // the user write it into the saved plan.
  const breakoutActive = stage2 && plan.stopFloor < plan.breakoutFloor;
  const stageLabel = stage2
    ? `Stage 2 · ATR trail active`
    : `Stage 1 · fixed floor until breakout`;
  const stageSub = stage2
    ? `4h close ${formatPrice(s.breakoutClose)} above ${formatPrice(plan.breakoutLevel)} on ${fmtWhen(s.breakoutAt)}`
    : `Trail starts after a 4h close above ${formatPrice(plan.breakoutLevel)}`;

  const ladder = [
    { id: 'hzh', label: 'High zone top', level: plan.highZone.high, kind: 'zone-hi' },
    { id: 'hzl', label: 'High zone bottom', level: plan.highZone.low, kind: 'zone-hi' },
    { id: 'bo', label: 'Breakout', level: plan.breakoutLevel, kind: 'level' },
    { id: 'sell', label: `Sell slice (${plan.slicePct}%)`, level: plan.sellLevel, kind: 'sell' },
    { id: 'hh', label: stage2 ? 'Highest high since breakout' : 'Highest high since anchor', level: s.highestHigh, kind: 'info' },
    { id: 'px', label: 'Price now', level: s.price, kind: 'price' },
    { id: 'lzh', label: 'Low zone top', level: plan.lowZone.high, kind: 'zone-lo' },
    { id: 'buy', label: `Buy back slice`, level: plan.buyBackLevel, kind: 'buy' },
    { id: 'lzl', label: 'Low zone bottom', level: plan.lowZone.low, kind: 'zone-lo' },
    { id: 'stop', label: `Effective stop (core ${plan.corePct}%)`, level: s.effectiveStop, kind: 'stop' },
    stage2
      ? { id: 'trail', label: `ATR trail (${s.mult}×)`, level: s.trail, kind: 'info' }
      : { id: 'trail', label: `${plan.atrMult}× trail (starts after breakout)`, level: s.previewTrail, kind: 'info' },
    { id: 'bof', label: 'Floor after breakout', level: plan.breakoutFloor, kind: 'info' },
    { id: 'floor', label: 'Manual floor', level: plan.stopFloor, kind: 'info' },
    { id: 'cost', label: 'Average cost', level: plan.avgCost, kind: 'info' },
  ]
    .filter((r) => Number.isFinite(r.level) && r.level > 0)
    .sort((a, b) => b.level - a.level || (a.kind === 'price' ? -1 : 1));

  return (
    <section className="card dp-stop">
      <div className="card__head">
        <h2>Live stop</h2>
        <span className="muted small">Kraken XDG/USD · 4h candles · ATR(14) Wilder</span>
      </div>

      <div className={`dp-stage dp-stage--${s.stage}`}>
        <span className="dp-stage__label">{stageLabel}</span>
        <span className="dp-stage__sub small">{stageSub}</span>
      </div>

      <div className="dp-stop__hero">
        <div>
          <p className="dp-stop__label muted">Effective stop</p>
          <p className="dp-stop__big mono">{formatPrice(s.effectiveStop)}</p>
          <p className="muted small">
            {stage2 ? 'Stage 2' : 'Stage 1'} · source: {SOURCE_COPY[s.stopSource]} · never moves down
          </p>
        </div>
        <div className="dp-stop__hero-right">
          <p className="dp-stop__label muted">Price</p>
          <p className="dp-stop__price mono">{formatPrice(s.price)}</p>
          <p className={`small mono ${market.change24h >= 0 ? 'pos' : 'neg'}`}>
            {market.change24h != null ? `${formatPct(market.change24h, 2)} 24h` : ''}
          </p>
        </div>
      </div>

      {stage2 ? (
        <div className="dp-stop__callout">
          Set your exchange trailing stop to <strong className="mono">~{s.trailPct.toFixed(1)}%</strong>
          <span className="muted">
            {' '}
            ({s.mult}× ATR = {fmtAtr(s.trailDistance)}
            {s.tightened ? ', tightened' : ''}). Base {plan.atrMult}× ≈ {s.baseTrailPct.toFixed(1)}% · tight{' '}
            {plan.tightMult}× ≈ {s.tightTrailPct.toFixed(1)}%.
          </span>
        </div>
      ) : (
        <div className="dp-stop__callout">
          Trailing stop starts after the <strong className="mono">{formatPrice(plan.breakoutLevel)}</strong>{' '}
          breakout (4h close above). Fixed stop is{' '}
          <strong className="mono">{formatPrice(s.effectiveStop)}</strong> for now.
          <span className="muted">
            {' '}
            For reference: {plan.atrMult}× ATR ≈ {s.baseTrailPct.toFixed(1)}% ({fmtAtr(s.baseTrailDistance)}); tight{' '}
            {plan.tightMult}× ≈ {s.tightTrailPct.toFixed(1)}%.
          </span>
        </div>
      )}

      {breakoutActive ? (
        <div className="dp-stop__breakout">
          <span>
            Breakout confirmed — the floor is already applied at{' '}
            <strong className="mono">{formatPrice(plan.breakoutFloor)}</strong>. Save it to your plan too?
          </span>
          <button type="button" className="btn" onClick={onRaiseFloor}>
            Save floor {formatPrice(plan.breakoutFloor)} to plan
          </button>
        </div>
      ) : null}

      <dl className="dp-stats">
        <Stat
          label="4h ATR"
          value={fmtAtr(s.atr)}
          sub={`${s.atrPct.toFixed(2)}% of price`}
        />
        <Stat
          label="90-day median ATR%"
          value={s.medianAtrPct != null ? `${s.medianAtrPct.toFixed(2)}%` : '—'}
          sub={
            volRatio
              ? `Now ${volRatio.toFixed(2)}× normal${s.medianCoverageDays < 89 ? ` (${Math.round(s.medianCoverageDays)}d data)` : ''}`
              : null
          }
          tone={volRatio > 1.3 ? 'dp-warn' : ''}
        />
        <Stat
          label={stage2 ? 'Highest high since breakout' : 'Highest high since anchor'}
          value={formatPrice(s.highestHigh)}
          sub={stage2 ? `Breakout ${fmtWhen(s.breakoutAt)}` : `Anchor ${fmtWhen(Date.parse(plan.anchorAt))}`}
        />
        {stage2 ? (
          <Stat
            label={`ATR trail (${s.mult}×${s.tightened ? ' tight' : ''})`}
            value={formatPrice(s.trail)}
            sub={
              s.tightenAt
                ? s.tightened
                  ? `Tight: price > ${formatUsd(s.tightenAt, { decimals: 4 })} (ref +${plan.tightenPct}%)`
                  : `Tightens above ${formatUsd(s.tightenAt, { decimals: 4 })}`
                : null
            }
          />
        ) : (
          <Stat
            label={`${plan.atrMult}× trail — starts after breakout`}
            value={formatPrice(s.previewTrail)}
            sub={`Not applied yet · tightens above ${formatUsd(s.tightenAt, { decimals: 4 })}`}
            tone="muted"
          />
        )}
        <Stat
          label="Distance to stop"
          value={s.distToStopPct != null ? `${s.distToStopPct.toFixed(2)}%` : '—'}
          sub={s.distToStopPct != null ? `${formatPrice(s.price - s.effectiveStop)} below price` : null}
          tone={s.distToStopPct != null && s.distToStopPct < 2 ? 'neg' : ''}
        />
        <Stat
          label={stage2 ? 'Floor (after breakout)' : 'Manual floor'}
          value={formatPrice(s.stageFloor)}
          sub={stage2 ? `Manual ${formatPrice(plan.stopFloor)} · breakout ${formatPrice(plan.breakoutFloor)}` : `→ ${formatPrice(plan.breakoutFloor)} after breakout`}
        />
      </dl>

      <h3 className="derived__title">Levels</h3>
      <ul className="dp-ladder">
        {ladder.map((r) => {
          const d = pctFrom(s.price, r.level);
          return (
            <li key={r.id} className={`dp-ladder__row dp-ladder__row--${r.kind}`}>
              <span className="dp-ladder__label">{r.label}</span>
              <span className="dp-ladder__price mono">{formatPrice(r.level)}</span>
              <span className="dp-ladder__pct mono muted">
                {r.kind === 'price' ? 'now' : formatPct(d, 1)}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="dp-stop__foot">
        <span className="muted small">
          Last 4h bar {fmtWhen(s.lastBarAt)} · {s.bars} bars
          {s.anchorBeforeData ? ' · anchor predates data (using oldest bar)' : ''}
        </span>
        <button type="button" className="btn btn--ghost" onClick={onResetTrail}>
          Restart plan from now
        </button>
      </div>
    </section>
  );
}
