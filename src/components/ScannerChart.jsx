import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
} from 'lightweight-charts';
import { fetchYahooChart } from '../lib/yahoo';
import { formatPrice } from '../lib/format';

/** UI range → Yahoo chart range */
export const SCANNER_RANGES = [
  { id: '1M', yahoo: '1mo', label: '1M' },
  { id: '1Y', yahoo: '1y', label: '1Y' },
  { id: '5Y', yahoo: '5y', label: '5Y' },
];

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
      return { time: tSec, open, high, low, close };
    })
    .filter(Boolean);
}

function yTick(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.1) return v.toFixed(3);
  return v.toFixed(4);
}

function formatAxisDate(tsSec) {
  if (!tsSec) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  }).format(new Date(tsSec * 1000));
}

/**
 * Compact daily candle chart for Scanner preview.
 * Fetches Yahoo history for 1mo / 1y / 5y.
 */
export default function ScannerChart({ symbol, rangeId = '1Y', onRangeChange }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [bars, setBars] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(null);
  const [chartEpoch, setChartEpoch] = useState(0);

  const range =
    SCANNER_RANGES.find((r) => r.id === rangeId) || SCANNER_RANGES[1];
  const candleBars = useMemo(() => ensureOhlcBars(bars), [bars]);

  useEffect(() => {
    if (!symbol) {
      setBars([]);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchYahooChart(symbol, range.yahoo, { signal: ac.signal })
      .then((result) => {
        if (ac.signal.aborted) return;
        setBars(result.bars || []);
        setLoading(false);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setBars([]);
        setError(err?.message || 'Chart failed');
        setLoading(false);
      });
    return () => ac.abort();
  }, [symbol, range.yahoo]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const chart = createChart(el, {
      autoSize: true,
      height: 220,
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
          color: 'rgba(139, 155, 180, 0.4)',
          labelBackgroundColor: '#182131',
        },
        horzLine: {
          color: 'rgba(139, 155, 180, 0.4)',
          labelBackgroundColor: '#182131',
        },
      },
      rightPriceScale: {
        borderColor: '#243044',
        scaleMargins: { top: 0.08, bottom: 0.12 },
      },
      timeScale: {
        borderColor: '#243044',
        timeVisible: false,
        barSpacing: rangeId === '1M' ? 7 : rangeId === '1Y' ? 4 : 2.5,
        minBarSpacing: 1.5,
      },
      localization: {
        priceFormatter: (p) => yTick(p),
        timeFormatter: (t) => formatAxisDate(t),
      },
    });

    const up = '#3d9cf0';
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
    };
  }, [symbol, rangeId]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(candleBars);
    if (candleBars.length) {
      if (rangeId === '1M') {
        chart.timeScale().fitContent();
      } else {
        chart.timeScale().scrollToRealTime();
      }
    }
  }, [candleBars, chartEpoch, rangeId]);

  return (
    <div className="scanner-chart">
      <div className="scanner-chart__head">
        <h3 className="scanner-chart__title">
          {symbol ? `${symbol} chart` : 'Chart'}
        </h3>
        <div className="segmented" role="group" aria-label="Chart range">
          {SCANNER_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`segmented__btn${rangeId === r.id ? ' is-active' : ''}`}
              onClick={() => onRangeChange?.(r.id)}
              disabled={!symbol}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="scanner-chart__error" role="status">
          Chart: {error}
        </p>
      ) : null}

      {loading && !candleBars.length ? (
        <p className="muted scanner-chart__empty">Loading candles…</p>
      ) : null}

      {!loading && !candleBars.length && !error && symbol ? (
        <p className="muted scanner-chart__empty">No history for range.</p>
      ) : null}

      <div
        className="scanner-chart__wrap"
        style={{ display: candleBars.length ? undefined : 'none' }}
      >
        <div className="scanner-chart__ohlc" aria-live="polite">
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
            <span className="muted small">Hover for OHLC</span>
          )}
        </div>
        <div ref={containerRef} className="scanner-chart__canvas" />
      </div>
    </div>
  );
}
