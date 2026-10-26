import { useEffect, useState } from 'react';

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/** Read-only research signals (PAPER, violet). No order buttons. */
export default function EdgesPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/bot/edges').then((r) => r.json()).then((j) => (j.error ? setErr(j.error) : setD(j))).catch(() => setErr('Could not load edges'));
  }, []);
  return (
    <section className="card mode-card--paper edges-panel" aria-label="Edges">
      <div className="edges-panel__head">
        <span className="mode-pill mode-pill--paper">PAPER</span>
        <strong>Edges</strong>
        <span className="muted edges-panel__asof">{d ? `as of ${d.index?.SPY?.date || ''} close` : err || 'loading…'}</span>
      </div>
      {d ? (
        <div className="edges-panel__grid">
          <div>
            <p className="edges-panel__k">Dip-buy triggers</p>
            <table className="edges-panel__t"><thead><tr><th></th><th>IBS&lt;0.2</th><th>RSI2&lt;10 &gt;200d</th></tr></thead>
              <tbody>{['SPY', 'QQQ'].map((s) => { const x = d.index[s]; return x ? (
                <tr key={s}><td>{s}</td>
                  <td className={x.ibsTrigger ? 'edges-on' : 'muted'}>{x.ibsTrigger ? 'ON' : 'off'} · {x.ibs.toFixed(2)}</td>
                  <td className={x.rsiTrigger ? 'edges-on' : 'muted'}>{x.rsiTrigger ? 'ON' : 'off'} · {x.rsi2.toFixed(1)}{x.above200 ? '' : ' (<200d)'}</td></tr>) : null; })}</tbody></table>
          </div>
          <div>
            <p className="edges-panel__k">3m momentum top 10</p>
            <p className="edges-panel__list">{d.mom3.map((m) => <span key={m.symbol}>{m.symbol} <em>{pct(m.m3)}</em></span>)}</p>
            <p className="edges-panel__k">12-1m momentum top 10</p>
            <p className="edges-panel__list">{d.mom121.map((m) => <span key={m.symbol}>{m.symbol} <em>{pct(m.m121)}</em></span>)}</p>
          </div>
          <div>
            <p className="edges-panel__k">Top 3 sectors (3m)</p>
            <p className="edges-panel__list">{d.sectors.map((s) => <span key={s.symbol}>{s.symbol} <em>{pct(s.m3)}</em>{s.above200 ? '' : ' <200d'}</span>)}</p>
            <p className="muted edges-panel__note">Universe: {d.universeSize} liquid large caps (≥$10M &amp; 1M sh/day). Monthly rebalance.</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
