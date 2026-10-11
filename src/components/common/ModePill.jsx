/**
 * Mode pill: violet PAPER (no real money) · gold LIVE $ / REAL $ (real money now) ·
 * gold-outline REAL $ · waiting (real-money plan, a live gate is off so nothing is sent yet).
 */
export default function ModePill({ mode, title, label, reason }) {
  if (mode === 'waiting') {
    return (
      <span className="mode-pill mode-pill--waiting" title={title || `Real-money plan, not sent yet: ${reason || 'a live switch is off'}`}>
        {label || `REAL $ · waiting${reason ? `: ${reason}` : ''}`}
      </span>
    );
  }
  const live = mode === 'live' || mode === 'real';
  return (
    <span className={`mode-pill mode-pill--${live ? 'live' : 'paper'}`} title={title || (live ? 'Real money' : 'Paper: simulated, no real money')}>
      {label || (live ? (mode === 'real' ? 'REAL $' : 'LIVE $') : 'PAPER')}
    </span>
  );
}
