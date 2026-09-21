import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPrice } from '../lib/format';

const LEVEL_COLORS = {
  support: '#3ecf8e',
  resistance: '#f07178',
  neutral: '#8b9bb4',
};

function formatAxisDate(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(ts);
}

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="chart-tooltip">
      <div className="muted small">{row.date}</div>
      <div>
        Close <strong className="mono">{formatPrice(row.close)}</strong>
      </div>
      {row.high != null && row.low != null && (
        <div className="muted small mono">
          H {formatPrice(row.high)} · L {formatPrice(row.low)}
        </div>
      )}
    </div>
  );
}

export default function PriceChart({
  bars,
  levels = [],
  days,
  onDaysChange,
  loading,
  error,
  warning,
  spot,
}) {
  const data = useMemo(() => bars || [], [bars]);

  const refLevels = useMemo(() => {
    const prefer = new Set([
      'median',
      'p25',
      'p75',
      'roll20_high',
      'roll20_low',
      'swing_high',
      'swing_low',
    ]);
    return (levels || []).filter((l) => prefer.has(l.id)).slice(0, 6);
  }, [levels]);

  const yDomain = useMemo(() => {
    if (!data.length) return ['auto', 'auto'];
    const lows = data.map((d) =>
      Number.isFinite(d.low) ? d.low : d.close,
    );
    const highs = data.map((d) =>
      Number.isFinite(d.high) ? d.high : d.close,
    );
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const pad = (max - min) * 0.08 || max * 0.02;
    return [Math.max(0, min - pad), max + pad];
  }, [data]);

  return (
    <section className="card price-chart">
      <div className="card__head">
        <h2>Daily DOGE chart</h2>
        <div className="segmented" role="group" aria-label="Lookback days">
          {[30, 90].map((d) => (
            <button
              key={d}
              type="button"
              className={`segmented__btn${days === d ? ' is-active' : ''}`}
              onClick={() => onDaysChange?.(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {warning && !error && <p className="warn-banner">{warning}</p>}
      {error && (
        <p className="error-banner">Could not load history: {error}</p>
      )}

      {loading && !data.length && (
        <p className="muted chart-empty">Loading daily closes…</p>
      )}

      {!loading && !data.length && !error && (
        <p className="muted chart-empty">No daily history yet.</p>
      )}

      {data.length > 0 && (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart
              data={data}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="dogeFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c2a633" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#c2a633" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1c2636" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={formatAxisDate}
                stroke="#8b9bb4"
                tick={{ fill: '#8b9bb4', fontSize: 11 }}
                minTickGap={40}
              />
              <YAxis
                domain={yDomain}
                tickFormatter={(v) =>
                  v >= 0.1 ? v.toFixed(3) : v.toFixed(4)
                }
                stroke="#8b9bb4"
                tick={{ fill: '#8b9bb4', fontSize: 11 }}
                width={56}
              />
              <Tooltip content={<ChartTooltip />} />
              <Area
                type="monotone"
                dataKey="close"
                stroke="#c2a633"
                strokeWidth={2}
                fill="url(#dogeFill)"
                isAnimationActive={false}
                name="Close"
              />
              {refLevels.map((lvl) => (
                <ReferenceLine
                  key={lvl.id}
                  y={lvl.price}
                  stroke={LEVEL_COLORS[lvl.type] || LEVEL_COLORS.neutral}
                  strokeDasharray="4 4"
                  strokeOpacity={0.85}
                />
              ))}
              {spot != null && (
                <ReferenceLine
                  y={spot}
                  stroke="#3d9cf0"
                  strokeWidth={1.5}
                  label={{
                    value: 'spot',
                    fill: '#3d9cf0',
                    fontSize: 11,
                    position: 'insideTopRight',
                  }}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
          <p className="muted small chart-legend">
            Area = daily close · tooltip shows high/low · dashed = key S/R ·
            blue = spot
          </p>
        </div>
      )}
    </section>
  );
}
