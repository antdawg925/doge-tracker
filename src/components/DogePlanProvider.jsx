import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DogePlanContext } from '../hooks/dogePlanContext.js';
import { computeStopSnapshot } from '../lib/atr.js';
import { buildRules, evaluateRules } from '../lib/alertRules.js';
import { fetchKrakenDailyBars, fetchKrakenSpot } from '../lib/history.js';
import {
  clearAlertLog,
  deleteHistoryEntry,
  loadPlanDoc,
  reloadServerState,
  resetTrail,
  savePlan,
  setPlanBackend,
} from '../lib/planStore.js';
import {
  notificationPermission,
  registerAlertsWorker,
  requestNotificationPermission,
  showNotification,
} from '../lib/notify.js';

export const POLL_MS = 90 * 1000;
/** A crossing notified in the browser isn't re-notified when the server logs it. */
const RENOTIFY_MS = 15 * 60 * 1000;
const HISTORY_DAYS = 120; // Kraken returns up to 720 × 4h bars

function snapshotFor(doc, bars, livePrice) {
  if (!doc || !bars?.length) return null;
  const { plan, stop } = doc;
  return computeStopSnapshot({
    bars,
    livePrice,
    anchorMs: Date.parse(plan.anchorAt),
    stopFloor: plan.stopFloor,
    breakoutLevel: plan.breakoutLevel,
    breakoutFloor: plan.breakoutFloor,
    atrMult: plan.atrMult,
    tightMult: plan.tightMult,
    tightenPct: plan.tightenPct,
    tightenRef: plan.tightenRef, // null → breakout level (handled in atr.js)
    prevEffectiveStop: stop.anchorAt === plan.anchorAt ? stop.effectiveStop : null,
  });
}

/**
 * App-wide DOGE plan state + polling. Mounted in AppLayout for signed-in users so
 * price alerts keep checking while any Trade Smart tab is open.
 * `backend` is the planStore storage adapter (Supabase for the signed-in user).
 */
export default function DogePlanProvider({ backend, children }) {
  const [doc, setDoc] = useState(null);
  const [storeError, setStoreError] = useState(null);
  const [market, setMarket] = useState({
    bars: null,
    livePrice: null,
    change24h: null,
    updatedAt: null,
    loading: true,
    error: null,
  });
  const [permission, setPermission] = useState(() => notificationPermission());
  const docRef = useRef(null);
  const marketRef = useRef(market);
  const busyRef = useRef(false);

  const commitDoc = useCallback((next) => {
    docRef.current = next;
    setDoc(next);
  }, []);

  const localRulesRef = useRef(null); // in-memory arming for faster browser notifications
  const seenLogRef = useRef(null); // server alert_log ids already seen
  const notifiedRef = useRef(new Map()); // ruleId → last browser notification (ms)

  const notify = useCallback((ruleId, title, body) => {
    const last = notifiedRef.current.get(ruleId) || 0;
    if (Date.now() - last < RENOTIFY_MS) return;
    notifiedRef.current.set(ruleId, Date.now());
    showNotification(title, { body, tag: `doge-${ruleId}` });
  }, []);

  /**
   * The server bot (every 5 min) owns stop memory, alert state and the alert log.
   * Each tick re-reads them so the page matches the server, then evaluates
   * crossings in memory only to show browser notifications while the app is open.
   */
  const processTick = useCallback(
    async (m) => {
      let d = docRef.current;
      if (!d) return;
      try {
        d = await reloadServerState();
        commitDoc(d);
      } catch {
        /* keep the last copy; next tick retries */
      }
      // Alerts the server logged since the last tick.
      const log = d.alerts.log || [];
      if (seenLogRef.current) {
        for (const e of log) {
          if (!seenLogRef.current.has(String(e.id))) notify(e.ruleId, e.title, e.body);
        }
      }
      seenLogRef.current = new Set(log.map((e) => String(e.id)));

      if (!m?.bars?.length) return;
      const snap = snapshotFor(d, m.bars, m.livePrice);
      if (!snap) return;
      const rules = buildRules(d.plan, snap);
      const { state, fired } = evaluateRules(rules, snap.price, localRulesRef.current ?? d.alerts.rules);
      localRulesRef.current = state;
      for (const f of fired) notify(f.ruleId, f.title, f.body);
    },
    [commitDoc, notify],
  );

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const pair = docRef.current?.plan?.pair || 'XDGUSD';
    setMarket((m) => ({ ...m, loading: true }));
    try {
      const [barsRes, spotRes] = await Promise.allSettled([
        fetchKrakenDailyBars(pair, HISTORY_DAYS, undefined, 240),
        fetchKrakenSpot(pair),
      ]);
      if (barsRes.status !== 'fulfilled') throw barsRes.reason;
      const bars = barsRes.value;
      const spot = spotRes.status === 'fulfilled' ? spotRes.value : null;
      const next = {
        bars,
        livePrice: spot?.price ?? bars[bars.length - 1]?.close ?? null,
        change24h: spot?.change24h ?? null,
        updatedAt: Date.now(),
        loading: false,
        error: null,
      };
      marketRef.current = next;
      setMarket(next);
      await processTick(next);
    } catch (err) {
      setMarket((m) => ({
        ...m,
        loading: false,
        error: String(err?.message || err || 'Kraken fetch failed'),
      }));
    } finally {
      busyRef.current = false;
    }
  }, [processTick]);

  // Point planStore at this user's storage, load the plan, then start polling.
  useEffect(() => {
    let alive = true;
    setPlanBackend(backend);
    const unsubscribe = backend?.onSyncError?.((err) => {
      if (alive) setStoreError(err ? `Couldn't save to your account: ${err.message}` : null);
    });
    let retry = null;
    const load = () =>
      loadPlanDoc()
        .then((d) => {
          if (!alive) return;
          setStoreError(null);
          commitDoc(d);
          refresh();
        })
        .catch((err) => {
          if (!alive) return;
          setStoreError(`Couldn't load your plan: ${err?.message || err}. Retrying…`);
          retry = setTimeout(load, 15000);
        });
    load();
    if (notificationPermission() === 'granted') registerAlertsWorker();
    const id = setInterval(() => {
      if (docRef.current) refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && docRef.current) {
        const age = Date.now() - (marketRef.current.updatedAt || 0);
        if (age > POLL_MS / 2) refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe?.();
      setPlanBackend(null);
    };
  }, [backend, commitDoc, refresh]);

  const snapshot = useMemo(
    () => snapshotFor(doc, market.bars, market.livePrice),
    [doc, market.bars, market.livePrice],
  );

  const actions = useMemo(
    () => ({
      async savePlan(plan) {
        const snap = snapshotFor(docRef.current, marketRef.current.bars, marketRef.current.livePrice);
        const d = await savePlan(plan, snap);
        commitDoc(d);
        await processTick(marketRef.current);
        return d;
      },
      async resetTrail() {
        const d = await resetTrail();
        localRulesRef.current = null;
        commitDoc(d);
        await processTick(marketRef.current);
      },
      async deleteHistoryEntry(id) {
        commitDoc(await deleteHistoryEntry(id));
      },
      async clearAlertLog() {
        commitDoc(await clearAlertLog());
      },
      async requestPermission() {
        const p = await requestNotificationPermission();
        setPermission(p);
        return p;
      },
    }),
    [commitDoc, processTick],
  );

  const value = useMemo(
    () => ({ doc, market, snapshot, permission, storeError, pollMs: POLL_MS, ...actions }),
    [doc, market, snapshot, permission, storeError, actions],
  );

  return <DogePlanContext.Provider value={value}>{children}</DogePlanContext.Provider>;
}
