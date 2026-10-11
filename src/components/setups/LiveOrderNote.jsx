import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import useSchwabStatus from '../stocks/useSchwabStatus.js';
import { closeMinutes, etParts, isTradingDay, liveBlockers } from '../../lib/botMode.js';

function rthNow(ms = Date.now()) {
  const p = etParts(ms);
  const m = p.hour * 60 + p.minute;
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

/** Quiet 2-line reminder under the real Buy $ / Short $ confirm. */
export default function LiveOrderNote({ gates }) {
  if (!gates?.loaded) return null;
  const blockers = liveBlockers(gates.stocksLive, gates.conn);
  const second = blockers.length ? `Stays pending until on: ${blockers.join(', ')}.` : rthNow() ? 'Places at the next 5-min check.' : 'Will be placed when the market opens.';
  return (
    <p className="small live-note">
      Real order — placed at Schwab during market hours (9:30–4 ET). Needs Stocks Live + Live Schwab stops on.
      <br />
      <span className={blockers.length ? 'live-note__wait' : ''}>{second}</span>
    </p>
  );
}
