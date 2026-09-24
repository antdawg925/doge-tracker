import { Link } from 'react-router-dom';

const CAPABILITIES = [
  {
    to: '/research',
    kicker: 'Research',
    title: 'Single-name workstation',
    body: 'Dig into one name: chart, levels, stage, fundamentals, news, and position.',
  },
  {
    to: '/scanner',
    kicker: 'Scanner',
    title: 'Momentum & Investable',
    body: 'Liquid equities across Momentum and Investable lanes — liquidity floor, sector, net cash, short %.',
  },
  {
    to: '/short-kings',
    kicker: 'Short Kings',
    title: 'Float & short interest',
    body: 'My Shorts (seeded watchlist) plus Hunt for float / short-interest research.',
  },
  {
    to: '/alerts',
    kicker: 'Alerts',
    title: 'Watchlist triggers',
    body: 'Price, stage, and RVOL alerts on your watchlist — still early / thin.',
  },
];

export default function Home() {
  return (
    <main className="landing">
      <section className="landing__hero">
        <div className="landing__brand">
          <img
            className="landing__bull"
            src="/bull-logo.png"
            srcSet="/bull-logo.png 1x, /bull-logo@2x.png 2x"
            alt=""
            width={168}
            height={168}
            decoding="async"
          />
          <div className="landing__brand-copy">
            <p className="landing__kicker muted">Trade Smart</p>
            <h1>Own the tape.</h1>
            <p className="landing__lede muted">
              Liquid stocks &amp; crypto — charts, levels, scanners, and
              short-interest tools in one dark workspace.
            </p>
            <div className="landing__cta-row">
              <Link to="/research" className="btn btn--primary">
                Open Research
              </Link>
              <Link to="/short-kings" className="btn btn--ghost">
                Short Kings
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="landing__grid" aria-label="App capabilities">
        {CAPABILITIES.map((cap) => (
          <Link key={cap.to} to={cap.to} className="landing__card card">
            <p className="landing__card-kicker muted">{cap.kicker}</p>
            <h2>{cap.title}</h2>
            <p className="landing__card-body muted">{cap.body}</p>
            <span className="landing__card-go" aria-hidden>
              Open →
            </span>
          </Link>
        ))}
      </section>

      <p className="landing__footer muted">
        Quotes &amp; history via Yahoo (stocks) and CoinGecko / Kraken fallbacks
        (crypto).
      </p>
    </main>
  );
}
