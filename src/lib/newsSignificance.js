/**
 * Heuristic keyword/category scorer for stock headlines (no LLM).
 * Returns { level: 'significant'|'watch'|'low', reasons: string[], score: number }.
 */

const SIGNIFICANT = [
  { re: /\bearnings?\b|\beps\b|\brevenue\b.*\b(beat|miss|surpass|fall|short)/i, reason: 'earnings/EPS/revenue' },
  { re: /\b(beat|miss)(s|ed|ing)?\b.*\b(eps|earnings|estimates?|revenue)\b/i, reason: 'earnings beat/miss' },
  { re: /\bguidance\b.*\b(raise|cut|lower|lift|boost|withdraw|slash)/i, reason: 'guidance change' },
  { re: /\b(raise|cut|lower|slash|withdraw)\w*\b.*\bguidance\b/i, reason: 'guidance change' },
  { re: /\bfda\b.*\b(approv\w*|reject\w*|clearance|crl)\b|\b(approv\w*|reject\w*)\b.*\bfda\b/i, reason: 'FDA decision' },
  { re: /\bclinical\s+trial|\bphase\s+[123i]+\b|\bpivotal\s+trial\b/i, reason: 'clinical trial' },
  { re: /\b(offering|dilution|atm\b|at[- ]the[- ]market|secondary\s+offering|follow[- ]on\s+offering)\b/i, reason: 'dilution/offering' },
  { re: /\bbankrupt|\bchapter\s+11\b|\bgoing\s+concern\b|\binsolven/i, reason: 'bankruptcy/going concern' },
  { re: /\b(merger|acquisition|acquire[sd]?|buyout|takeover|to\s+be\s+acquired)\b/i, reason: 'M&A' },
  { re: /\b(ceo|cfo|coo|cto)\b.*\b(resign|step\s+down|depart|oust|fired|quit)\b/i, reason: 'C-suite exit' },
  { re: /\b(resign|step\s+down|depart)\w*\b.*\b(ceo|cfo|coo|cto)\b/i, reason: 'C-suite exit' },
  { re: /\b(trading\s+)?halt|\bsuspended\s+from\s+trading\b|\bcircuit\s+breaker\b/i, reason: 'trading halt' },
  { re: /\b(sec|doj|ftc)\b.*\b(investigat|probe|subpoena|charg|lawsuit|complaint)\b/i, reason: 'regulator/investigation' },
  { re: /\binvestigat\w*\b.*\b(sec|doj|ftc|fraud)\b|\bsecurities\s+fraud\b/i, reason: 'regulator/investigation' },
  { re: /\b(stock\s+)?split\b|\breverse\s+split\b/i, reason: 'stock split' },
  { re: /\bbuyback\b|\brepurchase\s+(of\s+)?shares?\b|\bshare\s+repurchase\b/i, reason: 'buyback' },
  { re: /\b(upgrade|downgrade)\b.*\b(price\s+target|pt\b|\$\d)/i, reason: 'rating + PT move' },
  { re: /\bprice\s+target\b.*\b(raise|cut|lift|lower|boost|slash|to\s+\$)/i, reason: 'price target move' },
  { re: /\b(material|major|landmark|multi[- ]billion)\s+contract\b|\bwins?\s+.*\bcontract\b/i, reason: 'material contract' },
  { re: /\bdelist|\bnasdaq\s+compliance|\bnyse\s+compliance\b/i, reason: 'delisting risk' },
  { re: /\b(profit|sales)\s+warning\b|\brestat(e|ement)\b|\bwritedown\b|\bimpairment\b/i, reason: 'profit warning/restatement' },
];

const WATCH = [
  { re: /\bpartnership\b|\bjoint\s+venture\b|\bcollaborat/i, reason: 'partnership' },
  { re: /\bexpansion\b|\bopens?\s+new\b|\benter(s|ing)?\s+(the\s+)?market\b/i, reason: 'expansion' },
  { re: /\binsider\s+(buy|sell|purchase|sale|trading)\b|\bform\s+4\b/i, reason: 'insider activity' },
  { re: /\b(analyst\s+)?initiat(e|es|ion)\b|\bcoverage\s+initiat/i, reason: 'analyst initiation' },
  { re: /\bconference\b|\binvestor\s+day\b|\bpresent(s|ation)?\s+at\b|\bwebcast\b/i, reason: 'conference/presentation' },
  { re: /\b(upgrade|downgrade)\b/i, reason: 'analyst rating change' },
  { re: /\bdividend\b|\bspecial\s+dividend\b/i, reason: 'dividend news' },
  { re: /\bguidance\b|\boutlook\b|\bforecast\b/i, reason: 'outlook mention' },
];

const LOW_NOISE = [
  { re: /\btop\s+movers?\b|\bstocks?\s+(to\s+)?watch\b|\bpre[- ]?market\s+movers?\b/i, reason: 'generic movers list' },
  { re: /\bshares?\s+(rise|fall|jump|surge|plunge|rally|drop|soar|tumble)s?\b/i, reason: 'price-move headline' },
  { re: /\bmarket\s+wrap\b|\bstock\s+market\s+today\b|\bclosing\s+bell\b|\bwall\s+street\b.*\b(today|wrap)\b/i, reason: 'market wrap' },
  { re: /\bif\s+you\s+(had\s+)?invested\b|\bcould\s+you\s+become\s+a\s+millionaire\b|\bbest\s+stocks?\s+to\s+buy\b/i, reason: 'SEO/opinion spam' },
  { re: /\bwhy\s+.+\s+stock\s+(is\s+)?(up|down|jump)/i, reason: 'reactive price story' },
];

function uniqueReasons(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = String(r).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Score a headline (+ optional summary).
 * @param {{ title?: string, summary?: string }|string} input
 */
export function scoreNewsItem(input) {
  const title =
    typeof input === 'string'
      ? input
      : String(input?.title || input?.headline || '');
  const summary =
    typeof input === 'string' ? '' : String(input?.summary || input?.description || '');
  const text = `${title} ${summary}`.trim();
  if (!text) {
    return { level: 'low', reasons: ['empty headline'], score: 0 };
  }

  let score = 0;
  const reasons = [];

  for (const rule of SIGNIFICANT) {
    if (rule.re.test(text)) {
      score += 10;
      reasons.push(rule.reason);
    }
  }
  for (const rule of WATCH) {
    if (rule.re.test(text)) {
      score += 4;
      reasons.push(rule.reason);
    }
  }

  let noiseHits = 0;
  for (const rule of LOW_NOISE) {
    if (rule.re.test(text)) {
      noiseHits += 1;
      score -= 3;
      reasons.push(rule.reason);
    }
  }

  const uniq = uniqueReasons(reasons);
  let level = 'low';
  if (score >= 10 || uniq.some((r) => SIGNIFICANT.some((s) => s.reason === r))) {
    level = 'significant';
  } else if (score >= 4 && uniq.some((r) => WATCH.some((w) => w.reason === r))) {
    level = 'watch';
  } else if (noiseHits > 0 && score < 4) {
    level = 'low';
  } else if (score >= 4) {
    level = 'watch';
  }

  // Prefer actionable reasons in the UI tip
  const tipReasons =
    level === 'significant'
      ? uniq.filter((r) => SIGNIFICANT.some((s) => s.reason === r)).slice(0, 2)
      : level === 'watch'
        ? uniq.filter((r) => WATCH.some((w) => w.reason === r)).slice(0, 2)
        : uniq.slice(0, 1);

  return {
    level,
    reasons: tipReasons.length ? tipReasons : uniq.slice(0, 2),
    score,
  };
}

const LEVEL_ORDER = { significant: 0, watch: 1, low: 2 };

export function sortBySignificance(items) {
  return [...items].sort((a, b) => {
    const la = LEVEL_ORDER[a.significance?.level] ?? 9;
    const lb = LEVEL_ORDER[b.significance?.level] ?? 9;
    if (la !== lb) return la - lb;
    return (b.significance?.score || 0) - (a.significance?.score || 0);
  });
}

/**
 * One-line batch summary for the preview pane.
 */
export function summarizeSignificance(items) {
  const list = Array.isArray(items) ? items : [];
  const sig = list.filter((i) => i.significance?.level === 'significant');
  const watch = list.filter((i) => i.significance?.level === 'watch');
  if (!sig.length) {
    if (watch.length) {
      return `No high-significance headlines — ${watch.length} watch item${watch.length === 1 ? '' : 's'}.`;
    }
    return 'No high-significance headlines in this batch.';
  }
  const reasonBag = new Map();
  for (const item of sig) {
    for (const r of item.significance?.reasons || []) {
      reasonBag.set(r, (reasonBag.get(r) || 0) + 1);
    }
  }
  const top = [...reasonBag.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([r]) => r);
  const n = sig.length;
  const why = top.length ? ` — ${top.join(' + ')}` : '';
  return `${n} significant item${n === 1 ? '' : 's'}${why}`;
}

export const SIGNIFICANCE_LABELS = {
  significant: 'Significant',
  watch: 'Watch',
  low: 'Low signal',
};
