// How long ago a conversation was last written, as a person says it. The pure part of `StartChat.tsx`.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "2 days ago", then the date; empty for a time that is no time. */
export function ago(at: string | null, now: number = Date.now(), locale?: string): string {
  const then = at === null ? NaN : Date.parse(at)
  if (!Number.isFinite(then)) return ''
  const age = Math.max(0, now - then)
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return plural(Math.floor(age / MINUTE), 'minute')
  if (age < DAY) return plural(Math.floor(age / HOUR), 'hour')
  const days = Math.floor(age / DAY)
  if (days === 1) return 'yesterday'
  if (days < 14) return plural(days, 'day')
  const thisYear = new Date(then).getFullYear() === new Date(now).getFullYear()
  return `on ${new Date(then).toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) })}`
}
