/**
 * Per-user holdings in Supabase (`public.positions`, RLS: own rows only).
 * One row per (user, symbol). Research's position rail and the Positions tab
 * both read/write through here. Target price stays per-browser (appState).
 */
import { supabase } from './supabase.js';
import { assetKey } from './assets.js';
import { DEFAULTS, loadAppState, saveAppState } from './defaults.js';

const COLS = 'id, symbol, asset_type, asset_id, name, shares, avg_cost, notes, updated_at';
const IMPORT_FLAG = 'trade-smart-positions-imported-v1';

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(r) {
  return {
    ...r,
    symbol: String(r.symbol || '').toUpperCase(),
    shares: num(r.shares) ?? 0,
    avg_cost: num(r.avg_cost),
  };
}

/** Research/price asset shape for a DB row. */
export function rowToAsset(row) {
  return {
    symbol: row.symbol,
    name: row.name || row.symbol,
    type: row.asset_type === 'stock' ? 'stock' : 'crypto',
    id: row.asset_type === 'crypto' ? row.asset_id || undefined : undefined,
  };
}

/** Does a DB row describe this Research asset? (symbol + stock/crypto must match) */
export function rowMatchesAsset(row, asset) {
  if (!row || !asset) return false;
  if (row.symbol !== String(asset.symbol || '').toUpperCase()) return false;
  return row.asset_type === (asset.type === 'stock' ? 'stock' : 'crypto');
}

export async function listPositions() {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.from('positions').select(COLS).order('symbol');
  if (error) throw error;
  return (data || []).map(normalizeRow);
}

/** Insert or replace the row for asset.symbol. */
export async function upsertPosition(userId, asset, { shares, avgCost, notes } = {}) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const payload = {
    user_id: userId,
    symbol: String(asset.symbol || '').toUpperCase(),
    asset_type: asset.type === 'stock' ? 'stock' : 'crypto',
    asset_id: asset.type === 'stock' ? null : asset.id || null,
    name: asset.name || null,
    shares: Math.max(0, num(shares) ?? 0),
    avg_cost: num(avgCost) != null && num(avgCost) > 0 ? num(avgCost) : null,
  };
  if (notes !== undefined) payload.notes = notes || null;
  const { data, error } = await supabase
    .from('positions')
    .upsert(payload, { onConflict: 'user_id,symbol' })
    .select(COLS)
    .single();
  if (error) throw error;
  return normalizeRow(data);
}

export async function deletePosition(id) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.from('positions').delete().eq('id', id);
  if (error) throw error;
}

export async function deletePositionBySymbol(symbol) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase
    .from('positions')
    .delete()
    .eq('symbol', String(symbol || '').toUpperCase());
  if (error) throw error;
}

/**
 * One-time move of this browser's localStorage positions (Research rail) into
 * the DB. Existing DB rows win. Afterwards shares/avg cost are cleared from
 * localStorage (targets are kept) so it is never used for positions again.
 */
let importPromise = null;
export function importLocalPositionsOnce(userId) {
  if (!userId || !supabase) return Promise.resolve(0);
  if (!importPromise) {
    importPromise = runImport(userId).catch((err) => {
      importPromise = null;
      console.warn('Position import skipped', err);
      return 0;
    });
  }
  return importPromise;
}

async function runImport(userId) {
  let done = null;
  try {
    done = localStorage.getItem(IMPORT_FLAG);
  } catch {
    return 0;
  }
  if (done) return 0;

  const state = loadAppState();
  const known = new Map();
  for (const a of [state.selected, ...(state.watchlist || [])]) {
    if (a?.symbol) known.set(assetKey(a), a);
  }
  const rows = [];
  const seen = new Set();
  for (const [key, pos] of Object.entries(state.positions || {})) {
    const coins = Number(pos?.coins);
    const avg = Number(pos?.avgCost);
    if (!(coins > 0)) continue;
    // Untouched demo DOGE numbers are not a real holding.
    if (coins === DEFAULTS.coins && avg === DEFAULTS.avgCost) continue;
    let asset = known.get(key);
    if (!asset && key.startsWith('stock:')) {
      asset = { symbol: key.slice(6), type: 'stock', name: key.slice(6) };
    }
    if (!asset && key === 'crypto:dogecoin') {
      asset = { symbol: 'DOGE', type: 'crypto', id: 'dogecoin', name: 'Dogecoin' };
    }
    if (!asset) continue;
    const symbol = String(asset.symbol).toUpperCase();
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push({
      user_id: userId,
      symbol,
      asset_type: asset.type === 'stock' ? 'stock' : 'crypto',
      asset_id: asset.type === 'stock' ? null : asset.id || null,
      name: asset.name || symbol,
      shares: coins,
      avg_cost: avg > 0 ? avg : null,
    });
  }

  if (rows.length) {
    const { error } = await supabase
      .from('positions')
      .upsert(rows, { onConflict: 'user_id,symbol', ignoreDuplicates: true });
    if (error) throw error;
  }

  // Stop using localStorage for holdings: keep only per-symbol targets.
  const positions = {};
  for (const [key, pos] of Object.entries(state.positions || {})) {
    positions[key] = { coins: 0, avgCost: 0, targetPrice: Number(pos?.targetPrice) || 0 };
  }
  saveAppState({ ...state, positions });
  try {
    localStorage.setItem(IMPORT_FLAG, JSON.stringify({ userId, at: Date.now(), count: rows.length }));
  } catch {
    /* ignore */
  }
  return rows.length;
}

/** Portfolio math for one row given a live quote. */
export function rowMetrics(row, quote) {
  const shares = row.shares || 0;
  const price = quote?.price ?? null;
  const pct = quote?.change24h ?? null;
  const value = price != null ? shares * price : null;
  const basis = row.avg_cost != null ? shares * row.avg_cost : null;
  const gain = value != null && basis != null ? value - basis : null;
  const gainPct = gain != null && basis > 0 ? (gain / basis) * 100 : null;
  const dayChange =
    value != null && pct != null && pct > -100 ? value - value / (1 + pct / 100) : null;
  return { price, pct, value, basis, gain, gainPct, dayChange };
}
