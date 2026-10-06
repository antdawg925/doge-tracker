import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart } from 'lightweight-charts';

/**
 * Compact stock candles (Yahoo daily / weekly bars already loaded by the setup scan) with the
 * setup's major levels + entry / stop / target. Same chart lib as Research (lightweight-charts).
 * lines: [{ price, label, color, style: 'solid'|'dashed'|'dotted', width }]
 */
const fmt = (p) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(2) : p.toFixed(4));
const RANGES = [
  { id: '1d', label: '1D', bars: 180 },
  { id: '1w', label: '1W', bars: 156 },
];

/** Yahoo often omits today's bar (null close) while the quote has the live price: add/patch it. */
function withLive(src, spot, weekly) {
  const bars = (src || []).filter((b) => Number.isFinite(b?.close) && Number.isFinite(b?.t));
  if (!(spot > 0) || !bars.length) return bars;
  const last = bars[bars.length - 1];
  const now = Date.now();
  const et = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const sameDay = et(last.t) === et(now);
  const sameWeek = now - last.t < 7 * 86400000;
  if (weekly ? sameWeek : sameDay) {
    const patched = { ...last, close: spot, high: Math.max(last.high, spot), low: Math.min(last.low, spot) };
    return [...bars.slice(0, -1), patched];
  }
  return [...bars, { t: Math.max(now - 10 * 3600000, last.t + 3600000), open: last.close, high: Math.max(last.close, spot), low: Math.min(last.close, spot), close: spot }];
}

export default function SetupChart({ daily = [], weekly = [], lines = [], height = 260, symbol = '', spot = null }) {
  const el = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const drawn = useRef([]);
  const fitRef = useRef([]);
  const [range, setRange] = useState('1d');
  const bars = useMemo(() => {
    const src = withLive(range === '1w' ? weekly : daily, spot, range === '1w');
    const n = RANGES.find((r) => r.id === range)?.bars || 180;
    const seen = new Set();
    return (src || [])
      .filter((b) => Number.isFinite(b?.close) && Number.isFinite(b?.t))
      .slice(-n)
      .map((b) => ({ time: Math.floor(b.t / 1000), open: b.open, high: b.high, low: b.low, close: b.close }))
      .filter((b) => (seen.has(b.time) ? false : seen.add(b.time)))
      .sort((a, b) => a.time - b.time);
  }, [range, daily, weekly, spot]);

  useEffect(() => {
    fitRef.current = lines.filter((l) => !l.muted).map((l) => Number(l.price)).filter((v) => Number.isFinite(v) && v > 0);
  });

  useEffect(() => {
    const node = el.current;
    if (!node) return undefined;
    const chart = createChart(node, {
      autoSize: true,
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8b9bb4', fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: '#161f2d' }, horzLines: { color: '#161f2d' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#243044', scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { borderColor: '#243044', rightOffset: 4 },
      localization: { priceFormatter: fmt },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#3d9cf0', downColor: '#f07178', borderUpColor: '#3d9cf0', borderDownColor: '#f07178', wickUpColor: '#3d9cf0', wickDownColor: '#f07178',
      priceLineVisible: false,
      autoscaleInfoProvider: (orig) => {
        const res = orig();
        const extra = fitRef.current || [];
        if (!res || !extra.length) return res;
        return { ...res, priceRange: { minValue: Math.min(res.priceRange.minValue, ...extra), maxValue: Math.max(res.priceRange.maxValue, ...extra) } };
      },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      drawn.current = [];
    };
  }, [height]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.setData(bars);
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  const key = JSON.stringify(lines);
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const pl of drawn.current) s.removePriceLine(pl);
    drawn.current = lines
      .filter((l) => Number.isFinite(Number(l.price)) && l.price > 0)
      .map((l) =>
        s.createPriceLine({
          price: Number(l.price),
          color: l.color || '#5b6b84',
          lineWidth: l.width || 1,
          lineStyle: l.style === 'solid' ? LineStyle.Solid : l.style === 'dotted' ? LineStyle.Dotted : LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.label || '',
        }),
      );
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [key, lines, bars]);

  return (
    <div className="stp-chart">
      <div className="lchart__bar">
        <span className="small muted">{symbol} · Yahoo {range === '1w' ? 'weekly' : 'daily'}</span>
        <div className="lchart__ranges" role="tablist" aria-label="Chart range">
          {RANGES.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={range === x.id} className={`lchart__range${range === x.id ? ' is-active' : ''}`} onClick={() => setRange(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={el} className="stp-chart__canvas" style={{ height }} />
      {!bars.length ? <p className="small muted">No chart data.</p> : null}
    </div>
  );
}
