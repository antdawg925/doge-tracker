/** Filled mode pill: violet PAPER (no real money) or gold LIVE $ (real money). */
export default function ModePill({ mode, title }) {
  const live = mode === 'live';
  return (
    <span className={`mode-pill mode-pill--${live ? 'live' : 'paper'}`} title={title || (live ? 'Real money: the bot sends real orders' : 'Paper: simulated, no real money')}>
      {live ? 'LIVE $' : 'PAPER'}
    </span>
  );
}
