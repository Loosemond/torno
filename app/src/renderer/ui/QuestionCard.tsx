import { useEffect, useState } from 'react'
import { PICK_REF } from '../../shared/ask'
import { peek } from '../state/agent'
import { answerAsk, useOpenAsk } from '../state/asks'
import { useStore } from '../state/store'
import { giveKeysBack } from './typing'
import { numbered } from './numbered'

/**
 * The agent's question (`ask`): what it asks, a button for each answer with the refs it is about, which light in the
 * view while the pointer or the keys' focus is on the button, and "None of these". When the agent allows it, the person may
 * instead select one face or edge in the view and answer with that. Drawn in the chat, above the box, and, for a
 * terminal session that has no chat, over the foot of the view (`where`). The answer is only what was chosen: the card
 * changes nothing in the view beyond lighting the refs, as a ref chip does.
 */
export function QuestionCard({ where }: { where: 'chat' | 'view' }) {
  const ask = useOpenAsk(useStore((s) => s.objectId))
  // The viewport's card is for where the chat is not in sight: a terminal session, or the dock put away.
  const covered = useStore((s) => s.dockOpen && s.objectId !== null && s.sessions[s.objectId]?.view === 'chat')
  const layout = useStore((s) => s.layout)
  const selection = useStore((s) => s.selection)
  // Once answered the buttons stay off until main takes the question down.
  const [answered, setAnswered] = useState(false)
  const id = ask?.id
  useEffect(() => setAnswered(false), [id])
  // What is lit goes with the card.
  useEffect(() => () => peek([]), [id])
  if (!ask || (where === 'view' && covered)) return null

  const here = layout === ask.layout
  const light = (refs: string[]): void => peek(here ? refs : [])
  const picked = selection.length === 1 && PICK_REF.test(selection[0]) && here ? selection[0] : null
  const answer = (index: number | 'none' | 'pick', from: HTMLElement): void => {
    if (answered) return
    setAnswered(true)
    peek([])
    if (index === 'none') answerAsk(ask, { kind: 'declined' })
    else if (index === 'pick') {
      if (picked) answerAsk(ask, { kind: 'pick', ref: picked })
    } else answerAsk(ask, { kind: 'option', index })
    giveKeysBack(from)
  }

  return (
    <section className="ask-question" data-where={where} role="group" aria-label="The agent asks you to choose">
      <p className="ask-text selectable">{numbered(ask.question)}</p>
      {!here && <p className="ask-aside">Its refs are of layout {ask.layout}, not the one shown.</p>}
      <ul className="ask-options">
        {ask.options.map((option, n) => (
          <li key={n}>
            <button
              type="button"
              className="button ask-option"
              disabled={answered}
              onPointerEnter={() => light(option.refs)}
              onPointerLeave={() => light([])}
              onFocus={(e) => e.currentTarget.matches(':focus-visible') && light(option.refs)}
              onBlur={() => light([])}
              onClick={(e) => answer(n, e.currentTarget)}
            >
              <span className="ask-label">{option.label}</span>{' '}
              {option.refs.length > 0 && <span className="ask-refs num">{option.refs.join(', ')}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="ask-actions">
        {ask.pick && (
          <span className="ask-pick">
            {picked ? (
              <button type="button" className="button button-primary" disabled={answered} onClick={(e) => answer('pick', e.currentTarget)}>
                Answer with <span className="num">{picked}</span>
              </button>
            ) : (
              <span className="ask-aside">Or select one face or edge in the view.</span>
            )}
          </span>
        )}
        <button type="button" className="button button-quiet" disabled={answered} onClick={(e) => answer('none', e.currentTarget)}>
          None of these
        </button>
      </div>
    </section>
  )
}
