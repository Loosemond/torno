import type { ChatCommand, ChatMeta } from '../../../shared/chat'

/** From this share of a window used the foot of the chat says so. */
const SAY_FROM = 50

/** A window of the CLI's rate limit as a person says it: `five_hour` is "5-hour", `seven_day_opus` "7-day opus". */
function windowName(name: string): string {
  const [count, unit, ...rest] = name.split('_')
  const first = /^\d+$/.test(count) ? count : { five: '5', seven: '7', one: '1', thirty: '30' }[count]
  return first && unit ? [`${first}-${unit}`, ...rest].join(' ') : name.replace(/_/g, ' ')
}

/**
 * The quiet line in the foot of the chat: "5-hour limit: 72 % used, resets at 18:00", the time as the person's
 * locale writes it (24 hours if that is its way). Null while the most used window is under half used.
 */
export function rateLine(rate: ChatMeta['rate'], locale?: string): string | null {
  if (!rate || !(rate.used >= SAY_FROM)) return null
  const resets = rate.resetsAt !== undefined && Number.isFinite(rate.resetsAt) ? `, resets at ${new Date(rate.resetsAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}` : ''
  return `${windowName(rate.window)} limit: ${Math.round(rate.used)} % used${resets}`
}

/**
 * The commands to offer while the box holds a single `/word` and no space yet; none otherwise: those whose name
 * begins with what is typed.
 */
export function commandsFor(text: string, commands: readonly ChatCommand[]): ChatCommand[] {
  const typed = /^\/([^\s/]*)$/.exec(text)
  if (!typed) return []
  const word = typed[1].toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(word))
}
