#!/usr/bin/env node
/**
 * Paper competition feed sync (public, read-only).
 *
 * Reads the sanitized paper day-trade competition feed produced by the dtc engine
 * (`.venv/bin/python -m dtc site-publish` -> website/data/app.json), keeps ONLY an
 * allow-listed projection of fields the Paper tab renders, and writes
 * public/paper/feed.json (served by GET /api/paper/feed and as a static file).
 *
 * Paper money only. This script never touches brokers, bots, Telegram, Supabase or env vars.
 * It refuses to write if the output looks like it contains a local path or credential.
 *
 * Usage: node scripts/paper-sync.mjs [path/to/app.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] || '/workspace/paper-competition-2026-11-11/website/data/app.json'
const OUT = resolve(ROOT, 'public/paper/feed.json')

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
function pick(obj, keys) {
  if (!isObj(obj)) return undefined
  const out = {}
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]
  return out
}
const scalar = (v) => (v == null || typeof v !== 'object' ? v : undefined)
const strList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : isObj(x) ? String(x.reason || x.code || '') : '')).filter(Boolean) : undefined)
const floatOf = (f) => (isObj(f) ? pick(f, ['status', 'shares', 'float_shares']) : typeof f === 'number' ? f : undefined)

const ROW_KEYS = ['agent', 'competitor', 'symbol', 'session_date', 'observed_at', 'decision_at', 'snapshot_id', 'action', 'status',
  'setup', 'setup_class', 'setup_label', 'side', 'position_side', 'direction', 'skip_reason', 'reason', 'round_trip_target']
function row(r) {
  const out = {}
  for (const k of ROW_KEYS) { const v = scalar(r?.[k]); if (v != null && v !== '') out[k] = v }
  const sr = strList(r?.skip_reasons); if (sr?.length) out.skip_reasons = sr
  const fl = floatOf(r?.float); if (fl != null) out.float = fl
  return out
}
const TRADE_KEYS = ['symbol', 'side', 'position_side', 'direction', 'setup', 'setup_label', 'setup_class', 'entry_time', 'exit_time',
  'entry_price', 'exit_price', 'qty', 'shares', 'net_pnl', 'gross_pnl', 'fees', 'exit_reason', 'lesson', 'lesson_text', 'position_id', 'decision_id']
const trade = (t) => { const o = {}; for (const k of TRADE_KEYS) { const v = scalar(t?.[k]); if (v != null && v !== '') o[k] = v } return o }
const FILL_KEYS = ['agent', 'competitor', 'symbol', 'side', 'position_side', 'direction', 'price', 'fill_price', 'qty', 'shares',
  'fill_bar_start', 'observed_at', 'rejected', 'setup', 'setup_label', 'reason', 'net_pnl', 'lesson']
const fill = (f) => { const o = {}; for (const k of FILL_KEYS) { const v = scalar(f?.[k]); if (v != null && v !== '') o[k] = v } return o }

function account(a) {
  if (!isObj(a)) return {}
  const out = pick(a, ['competitor', 'initial_cash', 'settled_cash', 'unsettled_cash', 'realized_pnl', 'fees_paid', 'round_trip_target'])
  out.completed_round_trips = (a.completed_round_trips || []).filter(isObj).map(trade)
  const pos = a.positions
  out.positions = Array.isArray(pos) ? pos.filter(isObj).map(trade)
    : isObj(pos) ? Object.fromEntries(Object.entries(pos).filter(([, p]) => isObj(p)).map(([s, p]) => [s, trade(p)])) : {}
  return out
}

function probe(p) {
  if (!isObj(p)) return null
  const out = pick(p, ['probe_id', 'observed_at', 'session_date', 'passed', 'qualification_passed', 'label', 'invalidated',
    'eligible_fresh_count', 'min_eligible_required', 'in_session'])
  out.fail_reasons = strList(p.fail_reasons) || []
  out.symbols = (p.symbols || []).filter(isObj).map((s) => {
    const o = pick(s, ['symbol', 'eligible_fresh']); o.reasons = strList(s.reasons) || []
    const fl = floatOf(s.float); if (fl != null) o.float = fl
    return o
  })
  return out
}

const src = JSON.parse(readFileSync(SRC, 'utf8'))
const feed = {
  feed_version: 'paper-feed-v1',
  synced_at: new Date().toISOString(),
  ...pick(src, ['experiment_id', 'protocol_version', 'written_at_pt', 'generated_at_pt', 'official_trading_active', 'claimed_live', 'disclaimer']),
  database: 'Private local database (not published). This feed is a sanitized paper-trading projection.',
  fill_sources: pick(src.fill_sources, ['el_patron', 'stock_bot']) || {},
  backup: pick(src.backup, ['filename', 'written_at_pt']) || {},
  status: pick(src.status, ['official_trading_active', 'claimed_live', 'protocol_locked', 'freshness_qualified_for_forward_decisions', 'freshness_reason', 'snapshot_id']) || {},
  latest_probe: probe(src.latest_probe),
  accounts: Object.fromEntries(Object.entries(src.accounts || {}).map(([k, a]) => [k, account(a)])),
  candidates: (src.candidates || []).filter(isObj).map(row),
  decisions: (src.decisions || []).filter(isObj).map(row),
  fills: (src.fills || []).filter(isObj).map(fill),
}

const text = JSON.stringify(feed)
const DENY = [/\/workspace\//, /\/cursor\/stores/, /\/home\/box/, /\.venv/, /sqlite/i, /bearer\s/i, /api[_-]?key/i, /secret/i,
  /password/i, /refresh_token|access_token/i, /\bsk-[A-Za-z0-9]{12,}/, /\d{6,}:[A-Za-z0-9_-]{30,}/ /* telegram bot token shape */,
  /schwab/i, /kraken/i, /telegram/i, /supabase/i]
const hit = DENY.find((re) => re.test(text))
if (hit) {
  console.error(`paper-sync: refusing to write, output matched deny pattern ${hit}`)
  process.exit(2)
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, text + '\n')
console.log(`paper-sync: wrote ${OUT} (${(text.length / 1024).toFixed(0)} KB; ${feed.decisions.length} decisions, ${feed.candidates.length} candidates, ${feed.fills.length} fills; generated ${feed.generated_at_pt})`)
