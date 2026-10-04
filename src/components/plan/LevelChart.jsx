import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, PriceScaleMode, createChart } from 'lightweight-charts';
import { fetchKrakenDailyBars } from '../../lib/history.js';

/**
 * DOGE candles (Kraken XDGUSD, 4h or 1d) with labelled horizontal level lines.
 * lines: [{ price, label, color, style: 'solid'|'dashed'|'dotted', width, muted }] (muted: thin grey line, short title)
 * fit: prices the autoscale must include (e.g. the stop); log: logarithmic price scale.
 * onPick(line): tap near a line (≤10px) — optional.
 */
const RANGES = [
  { id: '4h', label: '4H', interval: 240, days: 45 },
  { id: '1d', label: '1D', interval: 1440, days: 365 },
];
const fmt = (p) => (p >= 1 ? p.toFixed(2) : p >= 0.1 ? p.toFixed(3) : p.toFixed(4));

export default function LevelChart({ lines = [], fit = [], log = false, height = 260, defaultRange = '4h', onPick = null, price = null }) {
  const el = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const drawn = useRef([]);
  const fitRef = useRef(fit);
  const pickRef = useRef(onPick);
  const linesRef = useRef(lines);
  const [range, setRange] = useState(defaultRange);
  const [bars, setBars] = useState([]);
  const [err, setErr] = useState(null);
  const r = RANGES.find((x) => x.id === range) || RANGES[0];

  useEffect(() => {
    fitRef.current = fit;
    pickRef.current = onPick;
    linesRef.current = lines;
  });

  useEffect(() => {
    const ac = new AbortController();
    fetchKrakenDailyBars('XDGUSD', r.days, ac.signal, r.interval)
      .then((b) => {
        setBars(b);
        setErr(null);
      })
      .catch((e) => e?.name !== 'AbortError' && setErr(e.message || 'Chart unavailable'));
    return () => ac.abort();
  }, [r.days, r.interval]);

  useEffect(() => {
    const node = el.current;
    if (!node) return undefined;
    const chart = createChart(node, {
      autoSize: true,
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8b9bb4', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: '#1a2333' }, horzLines: { color: '#1a2333' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#243044', mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { borderColor: '#243044', timeVisible: true, rightOffset: 3 },
      localization: { priceFormatter: fmt },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#3d9cf0', downColor: '#f07178', borderUpColor: '#3d9cf0', borderDownColor: '#f07178', wickUpColor: '#3d9cf0', wickDownColor: '#f07178',
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      autoscaleInfoProvider: (orig) => {
        const res = orig();
        const extra = (fitRef.current || []).filter((v) => Number.isFinite(v) && v > 0);
        if (!res || !extra.length) return res;
        return { ...res, priceRange: { minValue: Math.min(res.priceRange.minValue, ...extra), maxValue: Math.max(res.priceRange.maxValue, ...extra) } };
      },
    });
    const onClick = (param) => {
      if (!pickRef.current || !param?.point) return;
      let best = null;
      for (const l of linesRef.current) {
        const y = series.priceToCoordinate(l.price);
        if (y == null) continue;
        const d = Math.abs(y - param.point.y);
        if (d <= 10 && (!best || d < best.d)) best = { d, l };
      }
      if (best) pickRef.current(best.l);
    };
    chart.subscribeClick(onClick);
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.unsubscribeClick(onClick);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      drawn.current = [];
    };
  }, [height, log]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.setData(bars.map((b) => ({ time: Math.floor(b.t / 1000), open: b.open, high: b.high, low: b.low, close: b.close })));
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  const key = useMemo(() => JSON.stringify([lines, fit]), [lines, fit]);
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const pl of drawn.current) s.removePriceLine(pl);
    drawn.current = lines
      .filter((l) => Number.isFinite(Number(l.price)) && l.price > 0)
      .map((l) =>
        s.createPriceLine({
          price: Number(l.price),
          color: l.color || '#8b9bb4',
          lineWidth: l.width || 1,
          lineStyle: l.style === 'solid' ? LineStyle.Solid : l.style === 'dotted' ? LineStyle.Dotted : LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.label || '',
        }),
      );
    // re-apply autoscale with the new fit prices
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [key, lines, bars]);

  return (
    <div className="lchart">
      <div className="lchart__bar">
        <span className="small muted">DOGE/USD · Kraken{price ? ` · $${Number(price).toFixed(4)}` : ''}</span>
        <div className="lchart__ranges" role="tablist" aria-label="Chart range">
          {RANGES.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={range === x.id} className={`lchart__range${range === x.id ? ' is-active' : ''}`} onClick={() => setRange(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={el} className="lchart__canvas" style={{ height }} />
      {err ? <p className="small neg">{err}</p> : null}
    </div>
  );
}
