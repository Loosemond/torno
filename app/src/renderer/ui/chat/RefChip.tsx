import { useEffect, useMemo, useRef } from 'react'
import { peek } from '../../state/agent'
import { actions, useStore } from '../../state/store'
import { type RefInfo, refInfo } from './refs'

/**
 * A ref the chat shows (`M4`, `lid/F12`, `r12`) as a chip that is live: the pointer on it lights what it names in
 * the viewport, a click on a mark goes to it and a click on a face or an edge selects it. One that names nothing
 * in the window now (another layout, a part not drawn, a mark that is gone) says so in its tooltip and does
 * nothing else. `value` is the ref (`ref` is React's own word).
 */
export function RefChip({ value }: { value: string }) {
  // A string, so that the chip draws again only when what it says of the ref has changed.
  const said = useStore((s) => JSON.stringify(refInfo(s, value)))
  const info: RefInfo = useMemo(() => JSON.parse(said) as RefInfo, [said])
  const lit = useRef(false)
  const light = (on: boolean): void => {
    if (on === lit.current) return
    lit.current = on
    peek(on ? info.lights : [])
  }
  // A chip that goes while the pointer is on it takes its light with it.
  useEffect(() => () => light(false), [])
  // What it lights follows the state while the pointer is on it.
  useEffect(() => {
    if (lit.current) peek(info.lights)
  }, [info.lights.join(' ')])

  const props = { className: 'ref-chip num', 'data-ref': value, 'data-kind': info.kind, 'data-author': info.author, 'data-live': info.live ? '' : undefined, title: info.title }
  if (!info.live || info.act === undefined) return <span {...props}>{value}</span>
  return (
    <button
      type="button"
      {...props}
      onPointerEnter={() => light(true)}
      onPointerLeave={() => light(false)}
      onFocus={() => light(true)}
      onBlur={() => light(false)}
      onClick={() => {
        if (info.act === 'focus') actions.focusMark(value)
        else actions.setSelection([value])
      }}
    >
      {value}
    </button>
  )
}
