import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/authContext.js';
import { supabase } from '../lib/supabase.js';
import { BIAS, LEVEL_ACTIONS, currentStage, embedUrl, fetchPlanPosts, keyLines, ladderOf } from '../lib/plan.js';
import { fetchKrakenSpot } from '../lib/history.js';
import LevelChart from '../components/plan/LevelChart.jsx';

/** Plan: Anthony publishes (owner writes, RLS); every signed-in user reads. Members follow it on My Bot. */
const pt = (iso, time = true) =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', ...(time ? { hour: 'numeric', minute: '2-digit' } : {}) }) + (time ? ' PT' : '') : '—';
const px = (p) => `$${Number(p) >= 0.1 ? Number(p).toFixed(3).replace(/0$/, '') : Number(p).toFixed(4)}`;

function BiasPill({ bias }) {
  const b = BIAS[bias] || BIAS.neutral;
  return <span className={`plan-bias plan-bias--${bias}`}>{b.label}</span>;
}

/** Step-by-step plan, in the order price moves; the live stage is highlighted, buy zones are small text in their rows. */
function Ladder({ post, price }) {
  const rows = ladderOf(post);
  const now = currentStage(rows, price);
  return (
    <ol className="plan-ladder">
      {rows.map((r, i) => (
        <li key={i} className={i === now ? 'is-now' : i < now ? 'is-past' : ''}>
          <span className="plan-ladder__n">{i + 1}</span>
          <span className="mono plan-ladder__px">{r.px}</span>
          <span className="plan-ladder__txt">
            {r.text}
            {r.sub ? <span className="plan-ladder__sub">{r.sub}</span> : null}
          </span>
          {i === now ? <span className="plan-ladder__now">Now</span> : null}
        </li>
      ))}
    </ol>
  );
}

const ladderText = (rows) => (rows || []).map((r) => [r.from, r.px, r.text, r.sub || ''].join(' | ')).join('\n');
const parseLadder = (txt) =>
  txt
    .split('\n')
    .map((line) => line.split('|').map((x) => x.trim()))
    .filter((c) => c.length >= 3 && Number.isFinite(Number(c[0])) && c[2])
    .map(([from, px, text, sub]) => ({ from: Number(from), px, text, sub: sub || '' }));

function PostForm({ base, onPosted }) {
  const blank = { price: '', label: '', action: 'sell', on_chart: false };
  const [f, setF] = useState(() => ({
    title: '',
    video_url: '',
    note: '',
    bias: base?.bias || 'neutral',
    bias_reason: base?.bias_reason || '',
    stop_note: base?.stop_note || '',
    levels: (base?.levels || []).map((l) => ({ ...l, price: String(l.price), on_chart: !!l.on_chart })),
    ladder: ladderText(base?.ladder),
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setLv = (i, k) => (e) => setF((x) => ({ ...x, levels: x.levels.map((l, j) => (j === i ? { ...l, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value } : l)) }));
  const submit = async (e) => {
    e.preventDefault();
    const levels = f.levels.filter((l) => Number(l.price) > 0).map((l) => ({ price: Number(l.price), label: l.label.trim(), action: l.action, on_chart: !!l.on_chart }));
    if (!f.note.trim() && !f.video_url.trim()) return setMsg('Add a note or a video link.');
    setBusy(true);
    setMsg('');
    const { error } = await supabase.from('plan_posts').insert({
      symbol: 'DOGE',
      title: f.title.trim() || `DOGE plan: ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' })}`,
      video_url: f.video_url.trim() || null,
      note: f.note.trim(),
      bias: f.bias,
      bias_reason: f.bias_reason.trim(),
      stop_note: f.stop_note.trim(),
      levels,
      ladder: parseLadder(f.ladder),
    });
    setBusy(false);
    if (error) return setMsg(error.message);
    setMsg('Posted.');
    onPosted();
  };
  return (
    <details className="card plan-form">
      <summary>
        <span className="plan-h2">Post update</span> <span className="small muted">owner · members read it</span>
      </summary>
      <form onSubmit={submit} className="plan-form__body">
        <div className="plan-form__grid">
          <label>
            <span className="small muted">Title</span>
            <input value={f.title} onChange={set('title')} placeholder="DOGE plan: Oct 10 video" />
          </label>
          <label>
            <span className="small muted">Video link</span>
            <input type="url" value={f.video_url} onChange={set('video_url')} placeholder="https://youtube.com/…" />
          </label>
          <label>
            <span className="small muted">Bias</span>
            <select value={f.bias} onChange={set('bias')}>
              {Object.entries(BIAS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="small muted">Bias reason</span>
            <input value={f.bias_reason} onChange={set('bias_reason')} />
          </label>
        </div>
        <label>
          <span className="small muted">Note</span>
          <textarea rows={3} value={f.note} onChange={set('note')} />
        </label>
        <label>
          <span className="small muted">Stop note</span>
          <input value={f.stop_note} onChange={set('stop_note')} />
        </label>
        <div className="small muted">Levels · tick “chart” for key resistance (drawn on the charts); the rest are list-only zones</div>
        <div className="plan-form__levels">
          {f.levels.map((l, i) => (
            <div key={i} className="plan-form__lv">
              <input aria-label="Price" type="number" step="any" min="0" value={l.price} onChange={setLv(i, 'price')} placeholder="0.10" />
              <input aria-label="Label" value={l.label} onChange={setLv(i, 'label')} placeholder="Accumulate under" />
              <select aria-label="Action" value={l.action} onChange={setLv(i, 'action')}>
                {Object.entries(LEVEL_ACTIONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
              <label className="plan-form__chk" title="Show on chart">
                <input type="checkbox" checked={!!l.on_chart} onChange={setLv(i, 'on_chart')} /> <span className="small">chart</span>
              </label>
              <button type="button" className="btn btn--ghost stk-btn" aria-label="Remove level" onClick={() => setF((x) => ({ ...x, levels: x.levels.filter((_, j) => j !== i) }))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="btn btn--ghost stk-btn" onClick={() => setF((x) => ({ ...x, levels: [...x.levels, { ...blank }] }))}>
            + Level
          </button>
        </div>
        <label>
          <span className="small muted">Plan ladder · one stage per line: from price | price text | what to do | small text (zones)</span>
          <textarea rows={4} className="mono plan-form__ladder" value={f.ladder} onChange={set('ladder')} placeholder="0.10 | 0.14 | Sell some | Buy the dip 0.11–0.12" />
        </label>
        <div className="plan-form__actions">
          <button type="submit" className="btn btn--primary stk-btn" disabled={busy}>
            {busy ? 'Posting…' : 'Post update'}
          </button>
          {msg ? <span className="small muted">{msg}</span> : null}
        </div>
      </form>
    </details>
  );
}

export default function Plan() {
  const { isOwner } = useAuth();
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    fetchPlanPosts('DOGE', 20)
      .then(setPosts)
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const latest = posts?.[0] || null;
  const [price, setPrice] = useState(null);
  useEffect(() => {
    const ac = new AbortController();
    const tick = () =>
      fetchKrakenSpot('XDGUSD', { signal: ac.signal })
        .then((sp) => setPrice(sp.price))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 60000);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, []);
  const lines = useMemo(() => keyLines(latest?.levels), [latest]);
  const fit = useMemo(() => lines.map((l) => l.price), [lines]);
  const stop = (latest?.levels || []).find((l) => l.action === 'stop' && /bottom/i.test(l.label || ''));
  const video = latest?.video_url ? embedUrl(latest.video_url) : null;

  return (
    <main className="plan-page">
      <div className="plan-top">
        <h1 className="plan-title">Plan</h1>
        <span className="small muted">Anthony&apos;s DOGE plan · My Bot follows it by default</span>
      </div>
      {err ? <p className="auth-card__error">{err}</p> : null}
      {posts === null ? (
        <div className="card">
          <p className="muted">Loading…</p>
        </div>
      ) : !latest ? (
        <div className="card">
          <p className="muted">No plan posted yet.</p>
        </div>
      ) : (
        <div className="plan-grid">
          <section className="card plan-post">
            <div className="plan-post__head">
              <h2 className="plan-h2">{latest.title || 'Plan update'}</h2>
              <BiasPill bias={latest.bias} />
            </div>
            <p className="small muted">{pt(latest.created_at)}</p>
            {video ? (
              <div className="plan-video">
                <iframe src={video} title={latest.title || 'Plan video'} allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" />
              </div>
            ) : latest.video_url ? (
              <p>
                <a href={latest.video_url} target="_blank" rel="noreferrer">
                  Watch the video ↗
                </a>
              </p>
            ) : null}
            {latest.note ? <p className="plan-note">{latest.note}</p> : null}
            {latest.bias_reason ? (
              <p className="small">
                <span className="muted">Why {BIAS[latest.bias]?.label.toLowerCase() || 'this bias'}: </span>
                {latest.bias_reason}
              </p>
            ) : null}
          </section>

          <section className="card plan-chart">
            <LevelChart lines={lines} fit={fit} log height={300} defaultRange="1d" price={price} />
          </section>

          <section className="card plan-lv">
            <h2 className="plan-h2">The plan, step by step</h2>
            <Ladder post={latest} price={price} />
            <p className="small muted plan-bot">
              What the bot runs: one Kraken bottom stop under all your DOGE{stop ? ` (${px(stop.price)} now)` : ''} that only moves up: it ratchets under the
              4h high on a 3× daily-ATR trail and up to the account-lock price. Zone sells and the pot buy are off by default. {latest.stop_note}
            </p>
          </section>

          {isOwner ? <PostForm key={latest.id} base={latest} onPosted={load} /> : null}

          {posts.length > 1 ? (
            <section className="card plan-history">
              <h2 className="plan-h2">Earlier updates</h2>
              {posts.slice(1).map((p) => (
                <details key={p.id} className="plan-history__item">
                  <summary>
                    <span>{p.title || 'Plan update'}</span> <BiasPill bias={p.bias} /> <span className="small muted">{pt(p.created_at, false)}</span>
                  </summary>
                  {p.video_url ? (
                    <p className="small">
                      <a href={p.video_url} target="_blank" rel="noreferrer">
                        Video ↗
                      </a>
                    </p>
                  ) : null}
                  {p.note ? <p className="small">{p.note}</p> : null}
                  <Ladder post={p} price={null} />
                </details>
              ))}
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
