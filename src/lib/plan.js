import { supabase } from './supabase.js';

/** Plan levels: action → line colour / style for charts and pills. */
export const LEVEL_ACTIONS = {
  buy: { label: 'Buy', color: '#3ecf8e' },
  sell: { label: 'Sell', color: '#f5a524' },
  stop: { label: 'Stop', color: '#f07178' },
  tighten: { label: 'Tighten stop', color: '#e8875b' },
  target: { label: 'Target', color: '#3d9cf0' },
};
export const BIAS = {
  bullish: { label: 'Bullish', cls: 'pos' },
  neutral: { label: 'Neutral', cls: '' },
  cautious: { label: 'Cautious', cls: 'neg' },
};
export const actionOf = (a) => LEVEL_ACTIONS[a] || LEVEL_ACTIONS.target;

export async function fetchPlanPosts(symbol = 'DOGE', limit = 20) {
  if (!supabase) return [];
  const { data, error } = await supabase.from('plan_posts').select('*').eq('symbol', symbol).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

/** YouTube / Vimeo link → embeddable URL (else null: show a plain link). */
export function embedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\.|^m\./, '');
    if (h === 'youtu.be') return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    if (h === 'youtube.com') {
      if (u.pathname.startsWith('/embed/')) return url;
      if (u.pathname.startsWith('/shorts/')) return `https://www.youtube.com/embed/${u.pathname.split('/')[2]}`;
      const v = u.searchParams.get('v');
      return v ? `https://www.youtube.com/embed/${v}` : null;
    }
    if (h === 'vimeo.com') return `https://player.vimeo.com/video/${u.pathname.split('/').filter(Boolean)[0]}`;
  } catch {
    return null;
  }
  return null;
}

/** Short chart label: "0.20 heavy profits" (label up to the first ":" / "(", lower-case). */
export function chartLabel(l) {
  const p = Number(l.price);
  const n = p >= 0.1 ? p.toFixed(3).replace(/0$/, '') : p.toFixed(4);
  const t = String(l.label || '').split(/[:(]/)[0].trim().toLowerCase();
  return t ? `${n} ${t}` : n;
}

/** Key resistance lines only (levels with on_chart), thin and muted. */
export const keyLines = (levels) =>
  (levels || []).filter((l) => l.on_chart && Number(l.price) > 0).map((l) => ({ price: Number(l.price), label: chartLabel(l), color: '#5b6b82', style: 'dashed', muted: true }));

/** Ladder stages sorted by `from`; current = the last stage whose `from` ≤ price. Fallback: one row per level. */
export function ladderOf(post) {
  const rows = Array.isArray(post?.ladder) && post.ladder.length
    ? [...post.ladder].sort((a, b) => Number(a.from) - Number(b.from))
    : [...(post?.levels || [])].sort((a, b) => a.price - b.price).map((l) => ({ from: Number(l.price), px: chartLabel(l).split(' ')[0], text: l.label, sub: '' }));
  return rows;
}
export function currentStage(rows, price) {
  if (!price || !rows.length) return -1;
  let idx = 0;
  rows.forEach((r, i) => {
    if (Number(r.from) <= price) idx = i;
  });
  return idx;
}
