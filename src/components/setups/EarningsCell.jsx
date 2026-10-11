import { useState } from 'react';

const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

/** Why the date is red: same rule as shared/dipBuys.js + sellHighs.js (earnings within the next 14 days). */
export function earningsWhy(earningsAt, side = 'long') {
  const d = Math.max(0, Math.ceil((Number(earningsAt) - Date.now()) / 86400000));
  const when = d === 0 ? 'today' : d === 1 ? 'in 1 day' : `in ${d} days`;
  return `Earnings ${when} (${day(earningsAt)}): inside the 14-day window the bot flags as the fill + hold window. Price can gap past your ${side === 'short' ? 'cover stop' : 'stop'}, so the loss can exceed your $ risk. Consider waiting until after earnings or sizing smaller.`;
}

/** Earnings date; red + ⚠ (hover title, tap to show) when within 14 days. Clicks don't open the row preview. */
export default function EarningsCell({ earningsAt, warn, side = 'long' }) {
  const [open, setOpen] = useState(false);
  if (!earningsAt) return <td className="small muted">—</td>;
  if (!warn) return <td className="small muted">{day(earningsAt)}</td>;
  const why = earningsWhy(earningsAt, side);
  return (
    <td className="small neg earn-cell" title={why} onClick={(e) => e.stopPropagation()}>
      {day(earningsAt)}{' '}
      <button
        type="button"
        className="earn-warn"
        aria-label="Why earnings is flagged"
        aria-expanded={open}
        title={why}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
      >
        ⚠
      </button>
      {open ? (
        <span className="earn-pop" role="tooltip">
          {why}
        </span>
      ) : null}
    </td>
  );
}
