import { pressed } from '../../shared/keys'
import { useEffect, useRef } from 'react'
import { typed } from './typed'
import { giveKeysBack } from './typing'

/**
 * The number to keep of what a field holds, or null for nothing to keep: what was typed is no number, is what
 * the field showed (`shown`), or is what was kept of it a moment ago (`kept`: Enter keeps, and the focus then
 * leaves the field while it is still shown its old value).
 */
export function toKeep(text: string, shown: string, kept: string | null): number | null {
  const n = typed(text)
  const said = text.trim()
  return Number.isFinite(n) && said !== shown && said !== kept ? n : null
}

/** One number to type: the DOM's own while it is typed in; `commit` is given what was typed when it is a number. */
export function Field({ label, sign, axis, value, unit, disabled, commit }: { label: string; sign?: string; axis?: 'x' | 'y' | 'z'; value: string; unit?: string; disabled?: boolean; commit: (value: number, input: HTMLInputElement) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.value = value
  }, [value])
  /** What was last kept of what was typed, until the field is given another value: Enter keeps, and the blur that follows must not keep it again. */
  const kept = useRef<string | null>(null)
  useEffect(() => {
    kept.current = null
  }, [value])
  const done = (input: HTMLInputElement): void => {
    const n = toKeep(input.value, value, kept.current)
    if (n !== null) {
      kept.current = input.value.trim()
      commit(n, input)
    } else if (!Number.isFinite(typed(input.value))) input.value = value
  }
  return (
    <label className="shape-field align-field" data-axis={axis} data-disabled={disabled ? '' : undefined}>
      {sign && (
        <span className="shape-sign num" aria-hidden="true">
          {sign}
        </span>
      )}
      <input
        ref={ref}
        className="num"
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        defaultValue={value}
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => done(e.currentTarget)}
        onKeyDown={(e) => {
          if (pressed(e, 'field.keep')) done(e.currentTarget)
          else if (pressed(e, 'field.leave')) e.currentTarget.value = value
          else return
          e.preventDefault()
          e.stopPropagation()
          // Kept or left as it was, the keys are the view's again: the next letter is a tool's, not a figure.
          giveKeysBack(e.currentTarget)
        }}
      />
      {unit && (
        <span className="num align-unit" aria-hidden="true">
          {unit}
        </span>
      )}
    </label>
  )
}
