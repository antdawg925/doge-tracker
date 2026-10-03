import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api.js';

/** Schwab status (no tokens) for the Stocks tab; shared with the positions table. */
export default function useSchwabStatus() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const reload = useCallback(async () => {
    try {
      setStatus(await authedFetch('/api/schwab/status'));
      setErr('');
    } catch (e) {
      setErr(e.status === 403 ? '' : e.message);
      setStatus((s) => s ?? { configured: false, connection: null, forbidden: e.status === 403 });
    }
  }, []);
  useEffect(() => {
    reload();
    const id = setInterval(reload, 60_000);
    return () => clearInterval(id);
  }, [reload]);
  return { status, err, reload };
}

