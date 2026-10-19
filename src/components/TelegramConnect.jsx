import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../lib/api.js';

/**
 * Account → Telegram alerts. "Connect Telegram" gets a one-time t.me link (15 min) from the
 * server; tapping Start in Telegram links that chat to THIS account only. Polls while waiting.
 */
export default function TelegramConnect({ compact = false }) {
  const [st, setSt] = useState(null); // { connected, bot, configured }
  const [link, setLink] = useState(null); // { url, expiresAt }
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/api/telegram/status');
      setSt(r);
      if (r.connected) setLink(null);
      return r;
    } catch (e) {
      setMsg(e.message);
      return null;
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!link || st?.connected) return undefined;
    const t = setInterval(() => {
      if (Date.parse(link.expiresAt) < Date.now()) {
        setLink(null);
        setMsg('Link expired. Tap Connect Telegram again.');
      } else load();
    }, 3000);
    return () => clearInterval(t);
  }, [link, st?.connected, load]);
  const act = async (route) => {
    setBusy(route);
    setMsg('');
    try {
      const r = await authedFetch(`/api/telegram/${route}`, { method: 'POST' });
      if (route === 'link') {
        setLink(r);
        window.open(r.url, '_blank', 'noopener');
      } else if (route === 'test') setMsg('Test alert sent. Check Telegram.');
      else await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy('');
    }
  };
  if (!st) return <div className="tgc small muted">Telegram…</div>;
  return (
    <div className={`tgc${compact ? ' tgc--compact' : ''}`}>
      <div className="tgc__head">
        <strong>Telegram alerts</strong>
        {st.connected ? <span className="tgc__ok">Connected ✓</span> : <span className="small muted">Not connected</span>}
      </div>
      {st.connected ? (
        <>
          <p className="small muted">Your fills, stops and risk alerts come to your Telegram (quiet 9 PM–6 AM PT except urgent).</p>
          <div className="tgc__btns">
            <button type="button" className="btn btn--primary stk-btn" disabled={Boolean(busy)} onClick={() => act('test')}>
              {busy === 'test' ? 'Sending…' : 'Send test alert'}
            </button>
            <button type="button" className="btn btn--ghost stk-btn" disabled={Boolean(busy)} onClick={() => window.confirm('Stop Trade Smart alerts in Telegram?') && act('disconnect')}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">Get your own alerts in Telegram from @{st.bot}. Tap Connect, then Start in Telegram.</p>
          <div className="tgc__btns">
            <button type="button" className="btn btn--primary stk-btn" disabled={Boolean(busy) || !st.configured} onClick={() => act('link')}>
              {busy === 'link' ? 'Opening…' : link ? 'New link' : 'Connect Telegram'}
            </button>
          </div>
          {link ? (
            <p className="small tgc__wait">
              Waiting for you to tap <b>Start</b> in Telegram… <a href={link.url} target="_blank" rel="noopener noreferrer">Open Telegram</a> (link works once, 15 min)
            </p>
          ) : null}
        </>
      )}
      {msg ? <p className="small tgc__msg">{msg}</p> : null}
    </div>
  );
}
