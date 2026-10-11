import { useState } from 'react';

const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

/** Why the date is red: same rule as shared/dipBuys.js + sellHighs.js (earnings within the next 14 days). */
export function earningsWhy(earningsAt, side = 'long') {
  const d = Math.max(0, Math.ceil((Number(earningsAt) - Date.now()) / 86400000));
  const when = d === 0 ? 'today' : d === 1 ? 'in 1 day' : `in ${d} days`;
  const short = side === 'short';
  return `Heads-up: earnings ${when} (${day(earningsAt)}), before your likely exit. Price can gap past your ${short ? 'cover stop' : 'stop'} overnight. Safer: ${short ? 'cover' : 'sell'} before, enter after, or size down.`;
}

const Flag = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M3 1.5v13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M3.8 2.2h8.4l-2 3.1 2 3.1H3.8z" fill="currentColor" />
  </svg>
);

/** Earnings date; red + red flag (hover title, tap to show) when within 14 days. Clicks don't open the row preview. */
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
        <Flag />
      </button>
      {open ? (
        <span className="earn-pop" role="tooltip">
          {why}
        </span>
      ) : null}
    </td>
  );
}
