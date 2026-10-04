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
