/**
 * DOGE plan persistence — the ONLY module the Trade Smart Bot page uses for storage.
 *
 * All ratchet / history / alert-log rules live here and work on one document
 * through a swappable `backend` ({ read(): doc|null, write(doc) }):
 *   - signed in: Supabase (`planStoreSupabase.js`, per-user tables under RLS),
 *     selected by DogePlanProvider via setPlanBackend();
 *   - default / scripts: browser localStorage (key below).
 *
 * Document shape (key `trade-smart-doge-plan-v1` in localStorage):
 * {
 *   version: 2,
 *   plan: Plan,                  // current editable plan
 *   history: HistoryEntry[],     // newest first; one per Save
 *   stop: StopState,             // ratchet memory (effective stop never moves down)
 *   alerts: { rules: { [ruleId]: RuleState }, log: AlertLogEntry[] }
 * }
 *
 * Plan = {
 *   symbol: 'DOGE', pair: 'XDGUSD',
 *   avgCost, corePct, slicePct,
 *   sellLevel, buyBackLevel, stopFloor,
 *   breakoutLevel, breakoutFloor,          // on break of breakoutLevel, raise floor to breakoutFloor
 *   highZone: { low, high }, lowZone: { low, high },
 *   atrMult, tightMult, tightenPct,
 *   tightenRef: number|null,               // null → use breakoutLevel
 *   anchorAt: ISO string,                  // trail start; highest high measured from here
 *   note: string, updatedAt: ISO string|null
 * }
 * HistoryEntry = { id, savedAt: ISO, plan: Plan, note, market: { price, atr, atrPct, effectiveStop } | null }
 * StopState    = { effectiveStop: number|null, anchorAt: ISO|null, updatedAt: ISO|null, rulesVersion: number }
 *                 rulesVersion must equal STOP_RULES_VERSION or the stored stop is discarded
 *                 (v1 trailed from day one vs avg cost and could persist a too-tight ~$0.092 stop).
 * RuleState    = { armed: boolean, level: number }
 * AlertLogEntry= { id, at: ISO, ruleId, title, body, price, level }
 */

import { DEFAULT_PLAN, STOP_RULES_VERSION, normalizePlan } from '../../shared/plan.js';

export { DEFAULT_PLAN, STOP_RULES_VERSION, normalizePlan };

export const PLAN_STORAGE_KEY = 'trade-smart-doge-plan-v1';
export const HISTORY_LIMIT = 200;
export const LOG_LIMIT = 100;

/* ---------- backend adapter (localStorage default; Supabase when signed in) ---------- */

const localBackend = {
  async read() {
    try {
      const raw = globalThis.localStorage?.getItem(PLAN_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async write(doc) {
    try {
      globalThis.localStorage?.setItem(PLAN_STORAGE_KEY, JSON.stringify(doc));
    } catch {
      /* quota / private mode — keep in-memory copy */
    }
  },
};

let backend = localBackend;
/** Replace storage (e.g. server adapter with the same read/write contract). */
export function setPlanBackend(next) {
  backend = next || localBackend;
}

/* ---------- normalization (shared/plan.js) ---------- */

const stopRecord = (effectiveStop, anchorAt, updatedAt = new Date().toISOString()) => ({
  effectiveStop,
  anchorAt,
  updatedAt,
  rulesVersion: STOP_RULES_VERSION,
});

export function normalizeDoc(doc) {
  const plan = normalizePlan(doc?.plan);
  const stale = doc?.stop?.rulesVersion !== STOP_RULES_VERSION;
  const rules =
    doc?.alerts?.rules && typeof doc.alerts.rules === 'object' ? { ...doc.alerts.rules } : {};
  // Stale stop memory → drop it (and the stop alert's arming state) so it recomputes.
  if (stale) delete rules.stop;
  return {
    version: 2,
    plan,
    history: Array.isArray(doc?.history) ? doc.history.slice(0, HISTORY_LIMIT) : [],
    stop: stale
      ? stopRecord(null, plan.anchorAt, null)
      : stopRecord(
          Number.isFinite(doc.stop.effectiveStop) ? doc.stop.effectiveStop : null,
          doc.stop.anchorAt ?? plan.anchorAt,
          doc.stop.updatedAt ?? null,
        ),
    alerts: {
      rules,
      log: Array.isArray(doc?.alerts?.log) ? doc.alerts.log.slice(0, LOG_LIMIT) : [],
    },
  };
}

const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ---------- public API (all async) ---------- */

/** Load the whole document (creates defaults on first run; persists migrations). */
export async function loadPlanDoc() {
  const raw = await backend.read();
  const doc = normalizeDoc(raw);
  if (!raw || raw.version !== doc.version || raw.stop?.rulesVersion !== STOP_RULES_VERSION) {
    await backend.write(doc);
  }
  return doc;
}

/**
 * Save the plan and append a dated history entry (newest first).
 * `market` is an optional snapshot of live numbers at save time for later comparison.
 */
export async function savePlan(planInput, market = null) {
  const doc = normalizeDoc(await backend.read());
  const now = new Date().toISOString();
  const plan = normalizePlan({ ...planInput, updatedAt: now });
  const entry = {
    id: uid(),
    savedAt: now,
    plan,
    note: plan.note,
    market: market
      ? {
          price: market.price ?? null,
          atr: market.atr ?? null,
          atrPct: market.atrPct ?? null,
          effectiveStop: market.effectiveStop ?? null,
        }
      : null,
  };
  // Re-anchoring the trail resets ratchet memory; otherwise keep it.
  const reanchored = doc.stop.anchorAt !== plan.anchorAt;
  const next = {
    ...doc,
    plan,
    history: [entry, ...doc.history].slice(0, HISTORY_LIMIT),
    stop: reanchored ? stopRecord(null, plan.anchorAt, now) : doc.stop,
  };
  await backend.write(next);
  return next;
}

/** Delete one history entry. */
export async function deleteHistoryEntry(id) {
  const doc = normalizeDoc(await backend.read());
  const next = { ...doc, history: doc.history.filter((h) => h.id !== id) };
  await backend.write(next);
  return next;
}

/** Persist the ratchet (only ever raises the stored stop for the same anchor). */
export async function saveStopState(effectiveStop, anchorAt) {
  const doc = normalizeDoc(await backend.read());
  if (!Number.isFinite(effectiveStop)) return doc;
  const sameAnchor = doc.stop.anchorAt === anchorAt;
  const prev = sameAnchor ? doc.stop.effectiveStop : null;
  if (prev != null && effectiveStop <= prev) return doc;
  const next = { ...doc, stop: stopRecord(effectiveStop, anchorAt) };
  await backend.write(next);
  return next;
}

/** Start a fresh trail from now (clears ratchet memory). Does not add a history entry. */
export async function resetTrail(anchorAt = new Date().toISOString()) {
  const doc = normalizeDoc(await backend.read());
  const next = {
    ...doc,
    plan: { ...doc.plan, anchorAt },
    stop: stopRecord(null, anchorAt),
  };
  await backend.write(next);
  return next;
}

/** Persist alert rule arming state and prepend fired alerts to the log. */
export async function saveAlertState(rules, fired = []) {
  const doc = normalizeDoc(await backend.read());
  const stamped = fired.map((f) => ({ id: uid(), at: new Date().toISOString(), ...f }));
  const next = {
    ...doc,
    alerts: {
      rules,
      log: [...stamped, ...doc.alerts.log].slice(0, LOG_LIMIT),
    },
  };
  await backend.write(next);
  return next;
}

/**
 * Refresh the server-owned parts of the doc (stop memory, alert state, alert log)
 * when the backend supports it (Supabase). Local backend: returns the stored doc.
 */
export async function reloadServerState() {
  if (backend.pullServerState) return normalizeDoc(await backend.pullServerState());
  return normalizeDoc(await backend.read());
}

export async function clearAlertLog() {
  const doc = normalizeDoc(await backend.read());
  const next = { ...doc, alerts: { ...doc.alerts, log: [] } };
  await backend.write(next);
  return next;
}
