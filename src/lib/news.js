/**
 * Yahoo Finance news for a symbol (via Vite proxy /api/yahoo-search).
 * Primary: search with newsCount. Soft-fails so UI can show a warning.
 */

import { scoreNewsItem, sortBySignificance } from './newsSignificance.js';

const SEARCH_PROXY = '/api/yahoo-search';
const SEARCH_DIRECT = 'https://query2.finance.yahoo.com';

const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function searchUrls(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return [`${SEARCH_PROXY}${clean}`, `${SEARCH_DIRECT}${clean}`];
}

async function fetchJson(urls, { signal } = {}) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const headers = { Accept: 'application/json' };
      if (!url.startsWith('/')) headers['User-Agent'] = YAHOO_UA;
      const res = await fetch(url, { signal, headers });
      if (res.status === 429) {
        lastErr = new Error('HTTP 429 (Yahoo rate limited)');
        lastErr.rateLimited = true;
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`Yahoo news HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr =
        err instanceof Error ? err : new Error(String(err?.message || err));
    }
  }
  throw lastErr || new Error('Yahoo news fetch failed');
}

function newsQueryFor(assetOrSymbol) {
  if (!assetOrSymbol) return '';
  if (typeof assetOrSymbol === 'string') {
    return String(assetOrSymbol).trim().toUpperCase();
  }
  const sym = String(assetOrSymbol.symbol || '').trim().toUpperCase();
  if (!sym) return '';
  // Crypto often has a Yahoo *-USD pair; search still works on bare ticker.
  if (assetOrSymbol.type === 'crypto') return `${sym}-USD`;
  return sym;
}

function normalizeItem(raw) {
  const title = String(raw?.title || raw?.headline || '').trim();
  if (!title) return null;
  const publishedRaw = raw?.providerPublishTime ?? raw?.pubDate ?? raw?.published_at;
  let publishedAt = null;
  if (typeof publishedRaw === 'number' && Number.isFinite(publishedRaw)) {
    // Yahoo uses unix seconds
    publishedAt = publishedRaw > 1e12 ? publishedRaw : publishedRaw * 1000;
  } else if (typeof publishedRaw === 'string') {
    const t = Date.parse(publishedRaw);
    if (Number.isFinite(t)) publishedAt = t;
  }
  const summary = String(raw?.summary || raw?.description || '').trim() || null;
  const item = {
    id: String(raw?.uuid || raw?.id || `${title}:${publishedAt || 0}`),
    title,
    summary,
    source: String(raw?.publisher || raw?.provider || raw?.source || 'Yahoo').trim(),
    link: String(raw?.link || raw?.url || '').trim() || null,
    publishedAt,
    relatedTickers: Array.isArray(raw?.relatedTickers)
      ? raw.relatedTickers.map((t) => String(t).toUpperCase())
      : [],
  };
  item.significance = scoreNewsItem({ title: item.title, summary: item.summary });
  return item;
}

/**
 * Fetch news for an asset/symbol.
 * @returns {{ items: array, warning?: string, source: string }}
 */
export async function fetchSymbolNews(assetOrSymbol, { signal, limit = 12 } = {}) {
  const q = newsQueryFor(assetOrSymbol);
  if (!q) {
    return { items: [], warning: 'No symbol for news', source: 'yahoo' };
  }

  const path = `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=${Math.max(1, Math.min(20, limit))}`;
  try {
    const data = await fetchJson(searchUrls(path), { signal });
    const rawNews = Array.isArray(data?.news) ? data.news : [];
    const items = sortBySignificance(
      rawNews.map(normalizeItem).filter(Boolean),
    );
    if (!items.length) {
      return {
        items: [],
        warning: 'No Yahoo headlines for this symbol right now.',
        source: 'yahoo',
      };
    }
    return { items, source: 'yahoo' };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const warning = err?.rateLimited
      ? 'News rate-limited by Yahoo (429) — try again shortly.'
      : `News unavailable (${err?.message || 'fetch failed'}).`;
    return { items: [], warning, source: 'yahoo' };
  }
}

/** Relative time for news cards (compact). */
export function formatNewsTime(ts) {
  if (!ts || !Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(ts));
}
