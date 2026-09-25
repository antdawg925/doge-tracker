/**
 * Supabase backend for planStore.js (same { read, write } contract as localStorage).
 *
 * The document is split across per-user tables (all RLS "own rows only"):
 *   doge_plans (plan) · plan_history · stop_memory (version = rulesVersion) ·
 *   alert_state (rule arming) · alert_log
 *
 * read() loads once per session and then serves the in-memory copy, so the 90s
 * poll doesn't re-query five tables. write() diffs against the last state known
 * to be in the database and only touches what changed; a failed write keeps the
 * diff pending so the next write retries it.
 *
 * First sign-in: if the account has nothing stored yet and this browser has a
 * localStorage plan from before login, that plan + history + stop memory + alert
 * log are imported once (flagged in localStorage so another account on the same
 * browser doesn't import it too). The localStorage copy is left untouched.
 */
import {
  HISTORY_LIMIT,
  LOG_LIMIT,
  PLAN_STORAGE_KEY,
  normalizeDoc,
  normalizePlan,
} from './planStore.js';

export const IMPORT_FLAG_KEY = 'trade-smart-doge-plan-imported';

const EMPTY = Object.freeze({
  plan: null,
  history: [],
  stop: null,
  alerts: { rules: null, log: [] },
});

/** Key-order-insensitive JSON (jsonb reorders object keys). */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const same = (a, b) => stable(a) === stable(b);

const finiteOrNull = (n) => (Number.isFinite(n) ? n : null);

function historyToRow(h, userId) {
  return {
    id: String(h.id),
    user_id: userId,
    saved_at: h.savedAt,
    plan: h.plan,
    note: h.note ?? '',
    price_at_save: finiteOrNull(h.market?.price),
    stop_at_save: finiteOrNull(h.market?.effectiveStop),
    market: h.market ?? null,
  };
}
function rowToHistory(r) {
  return { id: r.id, savedAt: r.saved_at, plan: r.plan, note: r.note ?? '', market: r.market ?? null };
}

function logToRow(e, userId) {
  return {
    id: String(e.id),
    user_id: userId,
    fired_at: e.at,
    kind: e.ruleId ?? null,
    level: finiteOrNull(e.level),
    price: finiteOrNull(e.price),
    title: e.title ?? null,
    message: e.body ?? null,
  };
}
function rowToLog(r) {
  return {
    id: r.id,
    at: r.fired_at,
    ruleId: r.kind,
    title: r.title,
    body: r.message,
    price: r.price,
    level: r.level,
  };
}

function must({ data, error }) {
  if (error) throw new Error(error.message || 'Supabase request failed');
  return data;
}

function readLocalDoc() {
  try {
    if (globalThis.localStorage?.getItem(IMPORT_FLAG_KEY)) return null;
    const raw = globalThis.localStorage?.getItem(PLAN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 */
export function createSupabasePlanBackend(supabase, userId) {
  let cache = null; // latest doc handed to planStore (what the UI shows)
  let synced = EMPTY; // latest doc known to be in the database
  let loading = null;
  let queue = Promise.resolve();
  const listeners = new Set();
  const reportError = (err) => listeners.forEach((fn) => fn(err));

  async function fetchDoc() {
    const [plan, history, stop, alertState, log] = await Promise.all([
      supabase.from('doge_plans').select('plan').eq('user_id', userId).maybeSingle(),
      supabase
        .from('plan_history')
        .select('id, saved_at, plan, note, market')
        .eq('user_id', userId)
        .order('saved_at', { ascending: false })
        .limit(HISTORY_LIMIT),
      supabase.from('stop_memory').select('version, data').eq('user_id', userId).maybeSingle(),
      supabase.from('alert_state').select('data').eq('user_id', userId).maybeSingle(),
      supabase
        .from('alert_log')
        .select('id, fired_at, kind, level, price, title, message')
        .eq('user_id', userId)
        .order('fired_at', { ascending: false })
        .limit(LOG_LIMIT),
    ]).then((results) => results.map(must));

    if (!plan && !history.length) return null;
    return {
      version: 2,
      plan: plan?.plan ?? null,
      history: history.map(rowToHistory),
      stop: stop ? { ...stop.data, rulesVersion: stop.version } : null,
      alerts: { rules: alertState?.data ?? null, log: log.map(rowToLog) },
    };
  }

  async function persist(prev, next) {
    const now = new Date().toISOString();
    const ops = [];

    if (next.plan && !same(prev.plan, next.plan)) {
      ops.push(
        supabase.from('doge_plans').upsert({ user_id: userId, plan: next.plan, updated_at: now }),
      );
    }
    if (next.stop && !same(prev.stop, next.stop)) {
      const { rulesVersion, ...data } = next.stop;
      ops.push(
        supabase
          .from('stop_memory')
          .upsert({ user_id: userId, version: rulesVersion, data, updated_at: now }),
      );
    }
    const rules = next.alerts?.rules ?? {};
    if (!same(prev.alerts?.rules, rules)) {
      ops.push(supabase.from('alert_state').upsert({ user_id: userId, data: rules, updated_at: now }));
    }

    const prevHist = new Set(prev.history.map((h) => String(h.id)));
    const nextHist = new Set(next.history.map((h) => String(h.id)));
    const addHist = next.history.filter((h) => !prevHist.has(String(h.id)));
    const dropHist = [...prevHist].filter((id) => !nextHist.has(id));
    if (addHist.length) {
      ops.push(supabase.from('plan_history').upsert(addHist.map((h) => historyToRow(h, userId))));
    }
    if (dropHist.length) {
      ops.push(supabase.from('plan_history').delete().eq('user_id', userId).in('id', dropHist));
    }

    const prevLog = new Set(prev.alerts.log.map((e) => String(e.id)));
    const nextLog = new Set(next.alerts.log.map((e) => String(e.id)));
    const addLog = next.alerts.log.filter((e) => !prevLog.has(String(e.id)));
    const dropLog = [...prevLog].filter((id) => !nextLog.has(id));
    if (addLog.length) {
      ops.push(supabase.from('alert_log').upsert(addLog.map((e) => logToRow(e, userId))));
    }
    if (!next.alerts.log.length && prevLog.size) {
      ops.push(supabase.from('alert_log').delete().eq('user_id', userId));
    } else if (dropLog.length) {
      ops.push(supabase.from('alert_log').delete().eq('user_id', userId).in('id', dropLog));
    }

    (await Promise.all(ops)).forEach(must);
  }

  async function load() {
    let doc = await fetchDoc();
    if (doc) {
      synced = doc;
    } else {
      const local = readLocalDoc();
      if (local) {
        doc = normalizeDoc(local);
        // Older local history entries may predate some plan fields; fill them so
        // the history view can render every imported entry.
        doc = {
          ...doc,
          history: doc.history
            .filter((h) => h && h.id != null && h.savedAt)
            .map((h) => ({ ...h, plan: normalizePlan(h.plan) })),
        };
        await persist(EMPTY, doc);
        synced = doc;
        try {
          globalThis.localStorage?.setItem(
            IMPORT_FLAG_KEY,
            JSON.stringify({ userId, at: new Date().toISOString() }),
          );
        } catch {
          /* private mode: worst case the import is offered again to an empty account */
        }
      }
    }
    cache = doc;
    return doc;
  }

  return {
    kind: 'supabase',
    userId,
    /** Subscribe to background save failures (null = recovered). Returns unsubscribe. */
    onSyncError(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async read() {
      if (!loading) {
        loading = load().catch((err) => {
          loading = null; // let the next read retry
          throw err;
        });
      }
      await loading;
      return cache;
    },
    write(doc) {
      cache = doc;
      queue = queue.then(async () => {
        try {
          await persist(synced, doc);
          synced = doc;
          reportError(null);
        } catch (err) {
          reportError(err);
        }
      });
      return queue;
    },
  };
}
