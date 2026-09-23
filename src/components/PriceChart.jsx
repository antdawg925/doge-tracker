import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
} from 'lightweight-charts';
import { formatPrice, formatVolume } from '../lib/format';
import { displaySymbol } from '../lib/assets';
import {
  pickKeySupports,
  pickTopResistances,
  resistanceLevels,
} from '../lib/levels';
import { computeVolumeMetrics, volumeCoverage } from '../lib/volume';

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
      const volume =
        Number.isFinite(bar.volume) && bar.volume >= 0 ? Number(bar.volume) : null;
      return {
        ...bar,
        open,
        high,
        low,
        close,
        volume,
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

function toVolumeData(bars, upColor, downColor) {
  return bars
    .filter((b) => Number.isFinite(b.volume) && b.volume >= 0)
    .map((b) => ({
      time: b.time,
      value: b.volume,
      color: b.close >= b.open ? upColor : downColor,
    }));
}


/** Readable candle width; fitContent alone crushes ~90 bars to ~1px. */
const READABLE_BAR_SPACING = 8;
const MIN_BAR_SPACING = 6;

/**
 * Keep candles wide enough to read. Dense lookbacks (90d / many bars)
 * use fixed spacing + scroll to latest; shorter ranges may fitContent
 * when that stays at/above min spacing.
 */
function applyReadableTimeScale(chart, { barCount, days }) {
  if (!chart || !barCount) return;
  const ts = chart.timeScale();
  ts.applyOptions({
    barSpacing: READABLE_BAR_SPACING,
    minBarSpacing: MIN_BAR_SPACING,
  });
  const dense = days >= 90 || barCount > 40;
  if (dense) {
    ts.scrollToRealTime();
  } else {
    ts.fitContent();
  }
}


function VolumeMetricsStrip({ metrics, softNote }) {
  if (softNote && !metrics?.available) {
    return (
      <div className="volume-strip volume-strip--empty">
        <p className="muted small">{softNote}</p>
      </div>
    );
  }
  if (!metrics?.available) return null;

  const { latest, avg20, rvol, label, trend } = metrics;
  const rvolText =
    rvol != null && Number.isFinite(rvol) ? `${rvol.toFixed(2)}×` : '—';

  return (
    <div className="volume-strip" aria-label="Volume vs average">
      <div className="volume-strip__item">
        <span className="volume-strip__label">Today’s volume</span>
        <strong className="mono volume-strip__value">
          {formatVolume(latest)}
        </strong>
      </div>
      <div className="volume-strip__item">
        <span className="volume-strip__label">20-day average</span>
        <strong className="mono volume-strip__value">
          {formatVolume(avg20)}
        </strong>
      </div>
      <div className="volume-strip__item">
        <span className="volume-strip__label">Relative (RVOL)</span>
        <strong className="mono volume-strip__value">{rvolText}</strong>
        {label && (
          <span className={`volume-chip volume-chip--${label.key}`}>
            {label.text}
          </span>
        )}
      </div>
      {trend && (
        <div className="volume-strip__item volume-strip__item--trend">
          <span className="volume-strip__label">Lately</span>
          <span
            className={`volume-trend volume-trend--${trend.direction}`}
          >
            {trend.text}
          </span>
        </div>
      )}
    </div>
  );
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
  tfSets = null,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const priceLinesRef = useRef([]);
  const volumeAvgLineRef = useRef(null);
  const candleBarsRef = useRef([]);
  const refLevelsRef = useRef([]);
  const spotRef = useRef(spot);
  const metricsRef = useRef(null);
  const daysRef = useRef(days);
  const [hover, setHover] = useState(null);
  const [chartEpoch, setChartEpoch] = useState(0);

  const candleBars = useMemo(() => ensureOhlcBars(bars), [bars]);
  const sym = displaySymbol(asset);

  const volMetrics = useMemo(
    () => computeVolumeMetrics(candleBars),
    [candleBars],
  );
  const coverage = useMemo(() => volumeCoverage(candleBars), [candleBars]);
  const hasVolumePane = coverage.withVol >= 3;

  const volumeSoftNote = useMemo(() => {
    if (!candleBars.length) return null;
    if (hasVolumePane) return null;
    // Prefer explicit history warning about volume, else generic
    if (warning && /volume/i.test(warning)) return warning;
    return 'Volume not available for this history source — showing price candles only.';
  }, [candleBars.length, hasVolumePane, warning]);

  const refLevels = useMemo(() => {
    const supports = pickKeySupports(levels, spot, tfSets).slice(0, 5);
    const chartResists = resistanceLevels(levels, spot);
    const multiResists = pickTopResistances(
      tfSets,
      spot,
      0,
      0,
      null,
      levels,
    );
    const resistByKey = new Map();
    for (const l of [...chartResists, ...multiResists]) {
      if (!Number.isFinite(l.price)) continue;
      const key = Number(l.price).toPrecision(6);
      if (resistByKey.has(key)) continue;
      resistByKey.set(key, {
        id: l.id || `r-${key}`,
        price: l.price,
        type: 'resistance',
        label: l.friendlyLabel || l.label || l.name || '',
      });
    }
    const resists = [...resistByKey.values()]
      .sort((a, b) => a.price - b.price)
      .slice(0, 6);
    return [
      ...supports.map((l) => ({
        id: l.id,
        price: l.price,
        type: 'support',
        label: l.friendlyLabel,
      })),
      ...resists,
    ];
  }, [levels, spot, tfSets]);

  candleBarsRef.current = candleBars;
  refLevelsRef.current = refLevels;
  spotRef.current = spot;
  metricsRef.current = volMetrics;
  daysRef.current = days;

  /**
   * Keep the Y-axis anchored to candle volatility. Only fold in S/R that
   * sit near the visible candle range so far-away resistance does not
   * flatten the chart into a line.
   */
  function nearbyBand(candleMin, candleMax) {
    const span = Math.max(
      candleMax - candleMin,
      Math.abs(candleMax) * 0.01,
      1e-8,
    );
    return {
      span,
      // ~35% of recent candle range above highs / 25% below lows
      floor: candleMin - span * 0.25,
      ceiling: candleMax + span * 0.35,
    };
  }

  function applyAutoscale(series) {
    if (!series) return;
    series.applyOptions({
      autoscaleInfoProvider: (original) => {
        const base = typeof original === 'function' ? original() : null;
        if (!base?.priceRange) return base;
        const candleMin = base.priceRange.minValue;
        const candleMax = base.priceRange.maxValue;
        const { span, floor, ceiling } = nearbyBand(candleMin, candleMax);
        let minValue = candleMin;
        let maxValue = candleMax;
        for (const lvl of refLevelsRef.current) {
          if (!Number.isFinite(lvl.price)) continue;
          if (lvl.price < floor || lvl.price > ceiling) continue;
          minValue = Math.min(minValue, lvl.price);
          maxValue = Math.max(maxValue, lvl.price);
        }
        const s = spotRef.current;
        if (Number.isFinite(s)) {
          minValue = Math.min(minValue, s);
          maxValue = Math.max(maxValue, s);
        }
        const outSpan = Math.max(maxValue - minValue, span);
        return {
          ...base,
          priceRange: {
            minValue: minValue - outSpan * 0.04,
            maxValue: maxValue + outSpan * 0.06,
          },
        };
      },
    });
    try {
      series.priceScale().applyOptions({ autoScale: true });
    } catch {
      /* ignore */
    }
  }

  function applyPriceLines(series) {
    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* chart may already be gone */
      }
    }
    priceLinesRef.current = [];

    const bars = candleBarsRef.current || [];
    let candleMin = Infinity;
    let candleMax = -Infinity;
    for (const b of bars) {
      if (Number.isFinite(b.low)) candleMin = Math.min(candleMin, b.low);
      if (Number.isFinite(b.high)) candleMax = Math.max(candleMax, b.high);
    }
    const band =
      Number.isFinite(candleMin) && Number.isFinite(candleMax)
        ? nearbyBand(candleMin, candleMax)
        : null;

    for (const lvl of refLevelsRef.current) {
      if (!Number.isFinite(lvl.price)) continue;
      // Skip far S/R so axis labels do not pull attention off the action
      if (
        band &&
        (lvl.price < band.floor || lvl.price > band.ceiling)
      ) {
        continue;
      }
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

  function applyVolumeAvgLine(volSeries) {
    if (volumeAvgLineRef.current) {
      try {
        volSeries.removePriceLine(volumeAvgLineRef.current);
      } catch {
        /* ignore */
      }
      volumeAvgLineRef.current = null;
    }
    const avg = metricsRef.current?.avg20;
    if (!Number.isFinite(avg) || avg <= 0) return;
    volumeAvgLineRef.current = volSeries.createPriceLine({
      price: avg,
      color: 'rgba(139, 155, 180, 0.75)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '20d avg',
    });
  }

  // Create / recreate chart when asset type changes (up-candle color)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const chart = createChart(el, {
      autoSize: true,
      height: 360,
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
        barSpacing: READABLE_BAR_SPACING,
        minBarSpacing: MIN_BAR_SPACING,
      },
      localization: {
        priceFormatter: (p) => yTick(p),
        timeFormatter: (t) => formatAxisDate(t),
      },
    });

    const up = asset?.type === 'stock' ? '#3d9cf0' : '#3ecf8e';
    const down = '#f07178';
    const upVol =
      asset?.type === 'stock'
        ? 'rgba(61, 156, 240, 0.55)'
        : 'rgba(62, 207, 142, 0.55)';
    const downVol = 'rgba(240, 113, 120, 0.55)';

    const series = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    });

    const volSeries = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      },
      1,
    );

    const panes = chart.panes();
    if (panes[1]) {
      panes[1].setHeight(90);
    }

    chartRef.current = chart;
    seriesRef.current = series;
    volumeSeriesRef.current = volSeries;

    const initialBars = candleBarsRef.current;
    const initial = toCandleData(initialBars);
    series.setData(initial);
    volSeries.setData(toVolumeData(initialBars, upVol, downVol));
    applyReadableTimeScale(chart, {
      barCount: initial.length,
      days: daysRef.current,
    });
    applyAutoscale(series);
    applyPriceLines(series);
    applyVolumeAvgLine(volSeries);
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
      const volPoint = param.seriesData.get(volSeries);
      const matched = tSec
        ? candleBarsRef.current.find((b) => b.time === tSec)
        : null;
      setHover({
        date: tSec
          ? new Date(tSec * 1000).toISOString().slice(0, 10)
          : '',
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume:
          volPoint?.value ??
          matched?.volume ??
          null,
      });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      priceLinesRef.current = [];
      volumeAvgLineRef.current = null;
    };
  }, [asset?.type]);

  // Push candle + volume data when bars change (or chart was recreated)
  useEffect(() => {
    const series = seriesRef.current;
    const volSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const data = toCandleData(candleBars);
    series.setData(data);

    const upVol =
      asset?.type === 'stock'
        ? 'rgba(61, 156, 240, 0.55)'
        : 'rgba(62, 207, 142, 0.55)';
    const downVol = 'rgba(240, 113, 120, 0.55)';
    if (volSeries) {
      volSeries.setData(toVolumeData(candleBars, upVol, downVol));
      applyVolumeAvgLine(volSeries);
      // Hide empty volume pane height when no data
      const panes = chart.panes();
      if (panes[1]) {
        panes[1].setHeight(hasVolumePane ? 90 : 0);
      }
    }
    applyReadableTimeScale(chart, {
      barCount: data.length,
      days,
    });
  }, [candleBars, chartEpoch, asset?.type, hasVolumePane, days]);

  // Key S/R + spot price lines; expand Y scale to fit higher resistance
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    applyAutoscale(series);
    applyPriceLines(series);
  }, [refLevels, spot, chartEpoch]);

  // Keep avg line in sync when metrics change without bar identity change
  useEffect(() => {
    const volSeries = volumeSeriesRef.current;
    if (!volSeries) return;
    applyVolumeAvgLine(volSeries);
  }, [volMetrics, chartEpoch]);

  const displayWarning =
    warning && volumeSoftNote && warning === volumeSoftNote
      ? null
      : warning;

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

      {displayWarning && !error && (
        <p className="warn-banner">{displayWarning}</p>
      )}
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
              {hover.volume != null && (
                <span>
                  Vol{' '}
                  <strong className="mono">
                    {formatVolume(hover.volume)}
                  </strong>
                </span>
              )}
            </>
          ) : (
            <span className="muted small">
              Hover a candle for open / high / low / close
              {hasVolumePane ? ' / volume' : ''}
            </span>
          )}
        </div>
        <div ref={containerRef} className="chart-canvas" />
        <VolumeMetricsStrip
          metrics={volMetrics}
          softNote={volumeSoftNote}
        />
        {days >= 90 && (
          <p className="muted small chart-scroll-hint">
            Scroll / drag chart to see earlier days.
          </p>
        )}
        <p className="muted small chart-legend">
          Candles = daily OHLC · green/blue up · red down
          {hasVolumePane
            ? ' · bars below = daily volume (dashed = 20-day avg)'
            : ''}{' '}
          · green dashed = key support · red dashed = nearby resistance · white =
          spot
        </p>
      </div>
    </section>
  );
}
