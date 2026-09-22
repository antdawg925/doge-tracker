import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
} from 'lightweight-charts';
import { formatPrice } from '../lib/format';
import { displaySymbol } from '../lib/assets';
import { pickKeySupports, resistanceLevels } from '../lib/levels';

/**
 * Ensure each bar has usable OHLC. If open is missing, derive from prior
 * close or the mid of high/low; clamp high/low so the candle is valid.
 */
function ensureOhlcBars(bars) {
  if (!bars?.length) return [];
  let prevClose = null;
  return bars
    .map((bar) => {
      const close = Number(bar.close);
      if (!Number.isFinite(close)) return null;
      let high = Number.isFinite(bar.high) ? Number(bar.high) : close;
      let low = Number.isFinite(bar.low) ? Number(bar.low) : close;
      let open = Number.isFinite(bar.open) ? Number(bar.open) : null;
      if (open == null) {
        open = Number.isFinite(prevClose) ? prevClose : (high + low) / 2;
      }
      high = Math.max(high, open, close);
      low = Math.min(low, open, close);
      prevClose = close;
      const tSec = Math.floor(Number(bar.t) / 1000);
      return {
        ...bar,
        open,
        high,
        low,
        close,
        time: tSec,
      };
    })
    .filter(Boolean);
}

function formatAxisDate(tsSec) {
  if (!tsSec) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(tsSec * 1000));
}

function yTick(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.1) return v.toFixed(3);
  return v.toFixed(4);
}

function toCandleData(bars) {
  return bars.map((b) => ({
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
}

export default function PriceChart({
  asset,
  bars,
  levels = [],
  days,
  onDaysChange,
  loading,
  error,
  warning,
  spot,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const priceLinesRef = useRef([]);
  const candleBarsRef = useRef([]);
  const refLevelsRef = useRef([]);
  const spotRef = useRef(spot);
  const [hover, setHover] = useState(null);
  const [chartEpoch, setChartEpoch] = useState(0);

  const candleBars = useMemo(() => ensureOhlcBars(bars), [bars]);
  const sym = displaySymbol(asset);

  const refLevels = useMemo(() => {
    const supports = pickKeySupports(levels, spot);
    const resists = resistanceLevels(levels, spot).slice(0, 3);
    return [
      ...supports.map((l) => ({
        id: l.id,
        price: l.price,
        type: 'support',
        label: l.friendlyLabel,
      })),
      ...resists.map((l) => ({
        id: l.id,
        price: l.price,
        type: 'resistance',
        label: l.name,
      })),
    ];
  }, [levels, spot]);

  candleBarsRef.current = candleBars;
  refLevelsRef.current = refLevels;
  spotRef.current = spot;

  function applyPriceLines(series) {
    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* chart may already be gone */
      }
    }
    priceLinesRef.current = [];

    for (const lvl of refLevelsRef.current) {
      if (!Number.isFinite(lvl.price)) continue;
      const color =
        lvl.type === 'support'
          ? 'rgba(62, 207, 142, 0.85)'
          : 'rgba(240, 113, 120, 0.85)';
      priceLinesRef.current.push(
        series.createPriceLine({
          price: lvl.price,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: lvl.label || '',
        }),
      );
    }

    const s = spotRef.current;
    if (Number.isFinite(s)) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: s,
          color: 'rgba(232, 238, 247, 0.9)',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'spot',
        }),
      );
    }
  }

  // Create / recreate chart when asset type changes (up-candle color)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const chart = createChart(el, {
      autoSize: true,
      height: 280,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b9bb4',
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#1c2636' },
        horzLines: { color: '#1c2636' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(139, 155, 180, 0.45)',
          labelBackgroundColor: '#182131',
        },
        horzLine: {
          color: 'rgba(139, 155, 180, 0.45)',
          labelBackgroundColor: '#182131',
        },
      },
      rightPriceScale: {
        borderColor: '#243044',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: '#243044',
        timeVisible: false,
      },
      localization: {
        priceFormatter: (p) => yTick(p),
        timeFormatter: (t) => formatAxisDate(t),
      },
    });

    const up = asset?.type === 'stock' ? '#3d9cf0' : '#3ecf8e';
    const down = '#f07178';

    const series = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const initial = toCandleData(candleBarsRef.current);
    series.setData(initial);
    if (initial.length) chart.timeScale().fitContent();
    applyPriceLines(series);
    setChartEpoch((n) => n + 1);

    const onMove = (param) => {
      if (!param?.time || !param.seriesData) {
        setHover(null);
        return;
      }
      const candle = param.seriesData.get(series);
      if (!candle || candle.close == null) {
        setHover(null);
        return;
      }
      const tSec =
        typeof param.time === 'number'
          ? param.time
          : param.time?.timestamp ?? null;
      setHover({
        date: tSec
          ? new Date(tSec * 1000).toISOString().slice(0, 10)
          : '',
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, [asset?.type]);

  // Push candle data when bars change (or chart was recreated)
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const data = toCandleData(candleBars);
    series.setData(data);
    if (data.length) chart.timeScale().fitContent();
  }, [candleBars, chartEpoch]);

  // Key S/R + spot price lines
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    applyPriceLines(series);
  }, [refLevels, spot, chartEpoch]);

  return (
    <section className="card price-chart">
      <div className="card__head">
        <h2>Daily {sym} chart</h2>
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

      {loading && !candleBars.length && (
        <p className="muted chart-empty">Loading daily candles…</p>
      )}

      {!loading && !candleBars.length && !error && (
        <p className="muted chart-empty">No daily history yet.</p>
      )}

      {/* Keep container mounted so the chart can attach even while loading */}
      <div
        className="chart-wrap"
        style={{ display: candleBars.length ? undefined : 'none' }}
      >
        <div className="chart-ohlc" aria-live="polite">
          {hover ? (
            <>
              <span className="muted small">{hover.date}</span>
              <span>
                O <strong className="mono">{formatPrice(hover.open)}</strong>
              </span>
              <span>
                H <strong className="mono">{formatPrice(hover.high)}</strong>
              </span>
              <span>
                L <strong className="mono">{formatPrice(hover.low)}</strong>
              </span>
              <span>
                C <strong className="mono">{formatPrice(hover.close)}</strong>
              </span>
            </>
          ) : (
            <span className="muted small">
              Hover a candle for open / high / low / close
            </span>
          )}
        </div>
        <div ref={containerRef} className="chart-canvas" />
        <p className="muted small chart-legend">
          Candles = daily OHLC · green/blue up · red down · green dashed = key
          support · red dashed = resistance · white = spot
        </p>
      </div>
    </section>
  );
}
