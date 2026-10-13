import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import useSchwabStatus from '../stocks/useSchwabStatus.js';
import { closeMinutes, etParts, isTradingDay } from '../../lib/botMode.js';

function rthNow(ms = Date.now()) {
  const p = etParts(ms);
  const m = p.minutes;
  return isTradingDay(p.date, p.dow) && m >= 9 * 60 + 30 && m < closeMinutes(p.date);
}

/** Live gates for the signed-in user: Stocks Live (profile) + Schwab connection status. */
export function useLiveGates() {
  const schwab = useSchwabStatus();
  const [stocksLive, setStocksLive] = useState(null);
  useEffect(() => {
    let dead = false;
    supabase.auth.getUser().then(({ data }) => {
      const id = data?.user?.id;
      if (!id) return;
      supabase.from('profiles').select('stocks_live').eq('id', id).maybeSingle().then(({ data: p }) => !dead && setStocksLive(Boolean(p?.stocks_live)));
    });
    return () => {
      dead = true;
    };
  }, []);
  return { conn: schwab.status?.connection ?? null, stocksLive, loaded: stocksLive !== null && schwab.status !== null };
}

/** Quiet reminder under Buy $ / Short $: it's a REAL GTC limit placed at Schwab right away. */
export default function LiveOrderNote({ gates }) {
  if (!gates?.loaded) return null;
  const c = gates.conn;
  const block = !c || c.status !== 'connected' ? 'Connect Schwab first.' : c.killSwitch ? 'Live orders are PAUSED (kill switch).' : c.actionsToday >= c.dailyCap ? `Daily cap of ${c.dailyCap} Schwab actions reached.` : null;
  return (
    <p className="small live-note">
      Real GTC limit, sent to Schwab when you confirm. It can only fill in the regular session (9:30–4 ET){rthNow() ? '' : ', so it waits for the open'}. Stop goes in after the fill.
      {block ? (
        <>
          <br />
          <span className="live-note__wait">Blocked: {block}</span>
        </>
      ) : null}
    </p>
  );
}
