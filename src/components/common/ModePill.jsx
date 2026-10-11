/** Filled mode pill: violet PAPER (no real money) or gold LIVE $ / REAL $ (real money). */
export default function ModePill({ mode, title, label }) {
  const live = mode === 'live' || mode === 'real';
  return (
    <span className={`mode-pill mode-pill--${live ? 'live' : 'paper'}`} title={title || (live ? 'Real money' : 'Paper: simulated, no real money')}>
      {label || (live ? (mode === 'real' ? 'REAL $' : 'LIVE $') : 'PAPER')}
    </span>
  );
}
