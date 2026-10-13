/**
 * Paper ideas (`public.paper_ideas`, RLS own rows): simulated long/short trades tracked
 * beside real holdings. Never mixed into real totals.
 */
import { supabase } from './supabase.js';

const COLS = 'id, symbol, asset_type, asset_id, name, side, qty, entry_price, stop_price, target_price, source, status, opened_at, exit_price, closed_at, risk_cap_usd, risk_tripped_at, risk_trip_loss, limit_price, time_in_force, placed_at, filled_at, auto_exit, exit_reason, realized_pnl';
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const norm = (r) => ({ ...r, qty: n(r.qty), entry_price: n(r.entry_price), stop_price: n(r.stop_price), target_price: n(r.target_price), exit_price: n(r.exit_price), limit_price: n(r.limit_price), realized_pnl: n(r.realized_pnl), risk_cap_usd: n(r.risk_cap_usd) });

export async function listPaperIdeas({ symbol } = {}) {
  let q = supabase.from('paper_ideas').select(COLS).order('opened_at', { ascending: false }).limit(300);
  if (symbol) q = q.eq('symbol', String(symbol).toUpperCase());
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(norm);
}

/** asset: { symbol, type, id?, name? } */
export async function addPaperIdea(asset, { side = 'long', qty, entry, stop = null, target = null, source = 'manual', limit = null, requestId = null }) {
  const payload = {
    symbol: String(asset.symbol || '').toUpperCase(),
    asset_type: asset.type === 'crypto' ? 'crypto' : 'stock',
    asset_id: asset.type === 'crypto' ? asset.id || null : null,
    name: asset.name || null,
    side: side === 'short' ? 'short' : 'long',
    qty: n(qty),
    entry_price: n(entry),
    stop_price: n(stop) > 0 ? n(stop) : null,
    target_price: n(target) > 0 ? n(target) : null,
    source,
  };
  // Paper LIMIT order (Paper buy / Paper short): rests as pending GTC at the limit; the server fills it
  // when price trades through, then exits automatically at target / stop.
  if (n(limit) > 0) {
    if (payload.symbol === 'TSLA') throw new Error('TSLA is excluded from bot setups.');
    Object.assign(payload, { status: 'pending', limit_price: n(limit), entry_price: n(limit), time_in_force: 'GTC', placed_at: new Date().toISOString(), auto_exit: true });
  }
  if (!(payload.qty > 0) || !(payload.entry_price > 0)) throw new Error('Paper trade needs a size and an entry price.');
  if (requestId) payload.client_request_id = String(requestId).slice(0, 80);
  const { data, error } = await supabase.from('paper_ideas').insert(payload).select(COLS).single();
  if (error?.code === '23505' && requestId) {
    // Same press seen twice → return the order already saved (one press = one order).
    const { data: prev, error: e2 } = await supabase.from('paper_ideas').select(COLS).eq('client_request_id', payload.client_request_id).single();
    if (e2) throw e2;
    return { ...norm(prev), duplicate: true };
  }
  if (error) throw error;
  return norm(data);
}

export async function closePaperIdea(id, exitPrice) {
  const { data, error } = await supabase
    .from('paper_ideas')
    .update({ status: 'closed', exit_price: n(exitPrice), closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLS)
    .single();
  if (error) throw error;
  return norm(data);
}

export async function deletePaperIdea(id) {
  const { error } = await supabase.from('paper_ideas').delete().eq('id', id);
  if (error) throw error;
}

/** P&L for one idea at `price` (open) or its exit (closed). */
export function ideaPnl(idea, price) {
  const px = idea.status === 'closed' ? idea.exit_price : price;
  if (!(px > 0) || !(idea.entry_price > 0)) return { pnl: null, pct: null, px: px ?? null };
  const dir = idea.side === 'short' ? -1 : 1;
  const pnl = (px - idea.entry_price) * idea.qty * dir;
  return { pnl, pct: ((px / idea.entry_price - 1) * 100) * dir, px };
}


export const ideaAsset = (r) => ({ symbol: r.symbol, name: r.name || r.symbol, type: r.asset_type === 'crypto' ? 'crypto' : 'stock', id: r.asset_type === 'crypto' ? r.asset_id || undefined : undefined });

export async function cancelPaperOrder(id) {
  const { error } = await supabase.from('paper_ideas').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending');
  if (error) throw error;
}
