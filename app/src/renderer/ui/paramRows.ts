import { number } from '../../shared/format'
import type { Param } from '../../shared/scene'

/** What the Parameters section draws for one field of the model's `Params`. */
export interface ParamRow {
  name: string
  /** The text a click puts in the prompt: `Params.wall`. It names no geometry, so it is plain text there. */
  text: string
  /** The default as the person reads it, numbers to four digits; null where the kernel has no value to give (a default worked out in the model that JSON cannot say). */
  value: string | null
  /** The default whole, only where it differs from `value`. */
  full: string | null
  /** Whether the default in the source is not a literal (an expression, a `default_factory`). */
  worked: boolean
  /** The field's comment, as the model has it. */
  doc: string | null
  /** The row's tooltip: the name, the type as written, the value whole and the comment. */
  title: string
}

/** A value as Python writes it, numbers to four significant digits, or whole. */
function show(value: unknown, whole: boolean): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'number') return whole ? String(value) : number(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => show(item, whole)).join(', ')}]`
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${show(item, whole)}`).join(', ')}}`
  return String(value)
}

/** The row of a field. No unit is taken from its comment: the comment is shown as it was written. */
export function paramRow(param: Param): ParamRow {
  const worked = !param.literal
  const nothing = worked && param.default === null
  const value = nothing ? null : show(param.default, false)
  const whole = nothing ? null : show(param.default, true)
  const text = `Params.${param.name}`
  const said = [`${text}: ${param.type}`, whole !== null ? ` = ${whole}` : '', worked ? ', worked out in the model' : ''].join('')
  return {
    name: param.name,
    text,
    value,
    full: whole !== null && whole !== value ? whole : null,
    worked,
    doc: param.doc,
    title: param.doc ? `${said}. ${param.doc}` : said
  }
}
