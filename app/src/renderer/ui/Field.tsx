import { useEffect, useRef } from 'react'
import { typed } from './typed'

/** One number to type: the DOM's own while it is typed in; `commit` is given what was typed when it is a number. */
export function Field({ label, sign, axis, value, unit, disabled, commit }: { label: string; sign?: string; axis?: 'x' | 'y' | 'z'; value: string; unit?: string; disabled?: boolean; commit: (value: number, input: HTMLInputElement) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.value = value
  }, [value])
  const done = (input: HTMLInputElement): void => {
    const n = typed(input.value)
    if (Number.isFinite(n) && input.value.trim() !== value) commit(n, input)
    else if (!Number.isFinite(n)) input.value = value
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
          if (e.key === 'Enter') done(e.currentTarget)
          else if (e.key === 'Escape') e.currentTarget.value = value
          else return
          e.preventDefault()
          e.stopPropagation()
          e.currentTarget.select()
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
