import { authedFetch } from './api.js';

/** Schwab borrow fields for symbols via the bot-only /api/schwab/borrow route (caller's own Schwab login). */
export async function fetchSchwabBorrow(symbols) {
  if (!symbols?.length) return { available: false, rows: {} };
  try {
    return await authedFetch('/api/schwab/borrow', { method: 'POST', body: { symbols } });
  } catch (e) {
    return { available: false, reason: e.message, rows: {} };
  }
}
