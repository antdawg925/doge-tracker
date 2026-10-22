import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';

const fmtM = (v) => (v == null ? "—" : Number(v) >= 1e6 ? `$${(Number(v) / 1e6).toFixed(1)}M` : `$${(Number(v) / 1e3).toFixed(1)}k`);
const ago = (t) => {
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

function fundingRead(f) {
  if (f == null) return '';
  if (f > 0.03) return 'longs crowded';
  if (f < -0.01) return 'shorts paying, squeeze fuel';
  return 'neutral';
}

/** Compact DOGE signals: futures, X hype, whale transfers (logged hourly by the bot). */
export default function DogeSignals() {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!supabase) return;
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    Promise.all([
      supabase.from('doge_futures_snapshots').select('*').order('taken_at', { ascending: false }).limit(25),
      supabase.from('doge_hype_snapshots').select('*').order('taken_at', { ascending: false }).limit(1),
      supabase.from('doge_whale_moves').select('*').gte('tx_time', since).order('amount_usd', { ascending: false }).limit(50),
    ]).then(([f, h, w]) => setD({ f: f.data || [], h: h.data?.[0], w: w.data || [] }));
  }, []);
  if (!d) return null;
  const cur = d.f[0];
  const old = d.f.at(-1);
  const oiChg = cur && old && old !== cur && old.okx_oi_usd ? ((cur.okx_oi_usd / old.okx_oi_usd - 1) * 100).toFixed(1) : null;
  const whaleUsd = d.w.reduce((s, x) => s + Number(x.amount_usd || 0), 0);
  return (
    <section className="card mb-card dsig">
      <h2 className="mb-card__title">
        DOGE signals {cur ? <span className="small muted">· {ago(cur.taken_at)}</span> : null}
      </h2>
      {!cur ? (
        <p className="small muted">First snapshot logs within the hour.</p>
      ) : (
        <div className="dsig__grid small">
          <div>
            <span className="muted">Funding (8h)</span>
            <b>{cur.okx_funding_pct == null ? '—' : `${Number(cur.okx_funding_pct).toFixed(4)}%`}</b>
            <span className="muted">{fundingRead(cur.okx_funding_pct)}</span>
          </div>
          <div>
            <span className="muted">Open interest</span>
            <b>{fmtM(cur.okx_oi_usd)}</b>
            <span className="muted">{oiChg ? `${oiChg > 0 ? '+' : ''}${oiChg}% 24h` : 'OKX perp'}</span>
          </div>
          <div>
            <span className="muted">Long/short accts</span>
            <b>{cur.long_short_ratio ?? '—'}</b>
            <span className="muted">{cur.long_short_ratio > 3 ? 'retail heavy long' : ''}</span>
          </div>
          <div>
            <span className="muted">Liqs 4h L / S</span>
            <b>{fmtM(cur.liq_long_usd_4h)} / {fmtM(cur.liq_short_usd_4h)}</b>
          </div>
          <div>
            <span className="muted">X posts 24h</span>
            <b>{d.h?.post_count_24h ?? '—'}</b>
            <span className="muted">{d.h?.post_count_24h == null ? 'needs X key' : d.h?.note}</span>
          </div>
          <div>
            <span className="muted">Whales 24h (≥$1M)</span>
            <b>{d.w.length} · {fmtM(whaleUsd)}</b>
            <span className="muted">{d.w[0] ? `top ${(Number(d.w[0].amount_doge) / 1e6).toFixed(0)}M DOGE` : ''}</span>
          </div>
        </div>
      )}
    </section>
  );
}
