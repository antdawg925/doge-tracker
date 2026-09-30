/**
 * US stock market clock (America/New_York). Pure; used by the server stock pass.
 *   intraday: trading day, 9:30 ET <= now < close (16:00, or 13:00 on early-close days)
 *   close:    trading day, now >= close + 15 min, once per day (the after-close pass that
 *             moves stops on the completed daily candle)
 * Holidays: NYSE full-day closures 2026–2027 (extend the list yearly).
 */
export const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
/** 1:00 pm ET closes. */
export const NYSE_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;
export const EARLY_CLOSE_MIN = 13 * 60;
export const CLOSE_PASS_DELAY_MIN = 15;

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

/** { date: 'YYYY-MM-DD', minutes: minutes since ET midnight, dow: 0=Sun..6 } */
export function etParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), dow };
}

export const etDate = (ms) => etParts(ms).date;

export function isTradingDay(date, dow) {
  return dow >= 1 && dow <= 5 && !NYSE_HOLIDAYS.has(date);
}

export function closeMinutes(date) {
  return NYSE_EARLY_CLOSE.has(date) ? EARLY_CLOSE_MIN : CLOSE_MIN;
}

/** Has today's regular session finished (so today's daily candle is complete)? */
export function sessionClosed(ms) {
  const { date, minutes, dow } = etParts(ms);
  if (!isTradingDay(date, dow)) return true;
  return minutes >= closeMinutes(date);
}

/**
 * Which stock pass (if any) a cron tick at `ms` should run.
 * @param lastClosePassDate ET date of the last completed after-close pass (or null)
 * @returns {'intraday'|'close'|null}
 */
export function stockPassFor(ms, lastClosePassDate = null) {
  const { date, minutes, dow } = etParts(ms);
  if (!isTradingDay(date, dow)) return null;
  const close = closeMinutes(date);
  if (minutes >= OPEN_MIN && minutes < close) return 'intraday';
  if (minutes >= close + CLOSE_PASS_DELAY_MIN && lastClosePassDate !== date) return 'close';
  return null;
}
