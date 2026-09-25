/**
 * Optional Telegram notifier for bot alerts / decisions.
 * Sends only when BOTH exist: env TELEGRAM_BOT_TOKEN (BotFather token, sensitive
 * Vercel env) and the user's profiles.telegram_chat_id. Otherwise it silently skips.
 * Never throws; never logs the token.
 */
export function telegramEnabled() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN)
}

export async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId || !text) return { sent: false, skipped: true }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text: String(text).slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    })
    return { sent: res.ok, status: res.status }
  } catch (err) {
    return { sent: false, error: String(err?.name || 'send failed') }
  }
}

/** One compact message per run for a user: alert firings + non-hold decision. */
export function botMessage({ symbol, decision, reason, fired, price, lockReason }) {
  const lines = []
  if (lockReason) lines.push(`TSB LOCKED (${symbol}): ${lockReason}. Open My Bot and tap “Authorize next trade” to resume.`)
  if (decision && decision !== 'hold') lines.push(`Trade Smart Bot · ${symbol}: ${decision.replace(/_/g, ' ')} (watch-only)`)
  for (const f of fired || []) lines.push(`${f.title}. ${f.body}`)
  if (!lines.length) return null
  if (Number.isFinite(price)) lines.push(`Price ${price}`)
  if (reason) lines.push(reason)
  return lines.join('\n')
}
