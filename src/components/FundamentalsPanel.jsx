import { useStockFundamentals } from '../hooks/useStockFundamentals';
import {
  formatCompactUsd,
  formatMultiple,
  formatNetCash,
  formatRatioPct,
  formatShares,
} from '../lib/fundamentals';
import { displaySymbol } from '../lib/assets';

function Field({ label, value, hint, className = '' }) {
  return (
    <div className={`fund-field ${className}`.trim()}>
      <span className="fund-field__label">{label}</span>
      <strong className="fund-field__value mono">{value ?? '—'}</strong>
      {hint ? <span className="fund-field__hint muted">{hint}</span> : null}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="fund-section">
      <h3 className="fund-section__title">{title}</h3>
      <div className="fund-section__grid">{children}</div>
    </div>
  );
}

function dash(v) {
  return v == null || v === '' ? '—' : v;
}

/**
 * Desk fundamentals card. Stocks only — non-stock assets render nothing.
 */
export default function FundamentalsPanel({ asset, compact = false }) {
  const { data, loading, warning, isStock } = useStockFundamentals(asset);
  const sym = displaySymbol(asset);

  if (!asset?.symbol) {
    return null;
  }

  if (!isStock) return null;

  const net = data?.netCash;
  const netLabel =
    net == null ? 'Net cash / debt' : net >= 0 ? 'Net cash' : 'Net debt';
  const netHint =
    net == null
      ? 'cash − debt'
      : net >= 0
        ? 'cash − debt (positive)'
        : 'cash − debt (in parentheses)';

  return (
    <section
      className={`card fundamentals-panel${compact ? ' fundamentals-panel--compact' : ''}`}
      aria-label={`${sym} fundamentals`}
    >
      <div className="card__head">
        <h2>{sym} fundamentals</h2>
        {loading ? (
          <span className="muted small">Loading…</span>
        ) : (
          <span className="badge">Yahoo</span>
        )}
      </div>

      {warning && !loading ? (
        <p className="fundamentals-panel__warn" role="status">
          {warning}
        </p>
      ) : null}

      {loading && !data ? (
        <p className="muted fundamentals-panel__note">Fetching quoteSummary…</p>
      ) : null}

      {data ? (
        <div className="fundamentals-panel__body">
          <Section title="Profile">
            <Field label="Sector" value={dash(data.sector)} />
            <Field label="Industry" value={dash(data.industry)} />
            <Field label="Exchange" value={dash(data.exchange)} />
            <Field label="Mkt cap" value={formatCompactUsd(data.marketCap)} />
            {data.country ? (
              <Field label="Country" value={data.country} />
            ) : null}
          </Section>

          <Section title="Balance sheet">
            <Field label="Cash" value={formatCompactUsd(data.totalCash)} />
            <Field label="Debt" value={formatCompactUsd(data.totalDebt)} />
            <Field
              label={netLabel}
              value={formatNetCash(net)}
              hint={netHint}
              className={
                net == null ? '' : net >= 0 ? 'is-pos-ish' : 'is-neg-ish'
              }
            />
          </Section>

          <Section title="Short & float">
            <Field label="Float" value={formatShares(data.floatShares)} />
            <Field
              label="Short % float"
              value={formatRatioPct(data.shortPercentOfFloat)}
            />
            <Field
              label="Days to cover"
              value={
                data.shortRatio != null && Number.isFinite(data.shortRatio)
                  ? formatMultiple(data.shortRatio, 2)
                  : '—'
              }
              hint="short ratio"
            />
          </Section>

          <Section title="Valuation">
            <Field label="P/E" value={formatMultiple(data.trailingPE)} />
            <Field label="Fwd P/E" value={formatMultiple(data.forwardPE)} />
            <Field label="P/S" value={formatMultiple(data.priceToSales)} />
            {!compact ? (
              <>
                <Field
                  label="EV/Rev"
                  value={formatMultiple(data.enterpriseToRevenue)}
                />
                <Field
                  label="EV/EBITDA"
                  value={formatMultiple(data.enterpriseToEbitda)}
                />
              </>
            ) : null}
          </Section>

          <Section title="Quality">
            <Field label="Revenue" value={formatCompactUsd(data.totalRevenue)} />
            <Field
              label="Rev growth"
              value={formatRatioPct(data.revenueGrowth)}
            />
            <Field
              label="EPS growth"
              value={formatRatioPct(data.earningsGrowth)}
            />
            <Field
              label="Profit margin"
              value={formatRatioPct(data.profitMargins)}
            />
            <Field
              label="Op. margin"
              value={formatRatioPct(data.operatingMargins)}
            />
            <Field label="ROE" value={formatRatioPct(data.returnOnEquity)} />
          </Section>

          <Section title="Ownership">
            <Field
              label="Insiders"
              value={formatRatioPct(data.heldPercentInsiders)}
            />
            <Field
              label="Institutions"
              value={formatRatioPct(data.heldPercentInstitutions)}
            />
            <Field
              label="Beta"
              value={
                data.beta != null && Number.isFinite(data.beta)
                  ? formatMultiple(data.beta, 2)
                  : '—'
              }
            />
            <Field
              label="Div yield"
              value={formatRatioPct(data.dividendYield, 2)}
            />
          </Section>

          <Section title="Calendar">
            <Field
              label="Next earnings"
              value={dash(data.nextEarningsDate)}
            />
            {!compact ? (
              <>
                <Field
                  label="52w high"
                  value={
                    data.fiftyTwoWeekHigh != null
                      ? `$${formatMultiple(data.fiftyTwoWeekHigh, 2)}`
                      : '—'
                  }
                  hint={
                    data.pctFromHigh != null
                      ? formatRatioPct(data.pctFromHigh)
                      : null
                  }
                />
                <Field
                  label="52w low"
                  value={
                    data.fiftyTwoWeekLow != null
                      ? `$${formatMultiple(data.fiftyTwoWeekLow, 2)}`
                      : '—'
                  }
                  hint={
                    data.pctFromLow != null
                      ? formatRatioPct(data.pctFromLow)
                      : null
                  }
                />
              </>
            ) : null}
          </Section>
        </div>
      ) : null}

      <p className="fundamentals-panel__foot muted small">
        Yahoo quoteSummary — missing values show as —. Soft-fails on rate limits.
      </p>
    </section>
  );
}

/**
 * Compact strip for Scanner preview: sector / net / short%.
 */
export function FundamentalsStrip({ row, fundamentals }) {
  const f = fundamentals;
  const sector = f?.sector ?? row?.sector ?? null;
  const net = f?.netCash ?? row?.netCash ?? null;
  const shortPct = f?.shortPercentOfFloat ?? row?.shortPercentOfFloat ?? null;
  const loading = !f && sector == null && net == null && shortPct == null;

  return (
    <div className="card fundamentals-strip" aria-label="Fundamentals snapshot">
      <div className="fundamentals-strip__grid">
        <Field label="Sector" value={dash(sector)} />
        <Field
          label={net != null && net < 0 ? 'Net debt' : 'Net cash'}
          value={formatNetCash(net)}
        />
        <Field label="Short %" value={formatRatioPct(shortPct)} />
      </div>
      {loading ? (
        <p className="muted small fundamentals-strip__note">Loading fundamentals…</p>
      ) : null}
    </div>
  );
}
