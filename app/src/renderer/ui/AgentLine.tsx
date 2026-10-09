import { dismissHighlight, useAgentHighlight } from '../state/agent'
import { useStore } from '../state/store'

/**
 * What the agent is pointing at, at the bottom of the viewport where the
 * selection is shown: its refs as chips in the colour of its marks, what it
 * says of them, and a way to put it away. The note is the agent's own text,
 * shown as text.
 */
export function AgentLine() {
  const highlight = useAgentHighlight()
  const selecting = useStore((s) => s.selection.length > 0)
  if (!highlight) return null
  return (
    <div className="agent-line" role="status" aria-label="The agent points at" data-above={selecting ? '' : undefined}>
      <ul className="agent-refs">
        {highlight.refs.map((ref) => (
          <li key={ref} className="mark-chip agent-ref num" data-author="agent" data-ref={ref}>
            {ref}
          </li>
        ))}
      </ul>
      {highlight.note !== '' && (
        <span className="agent-note selectable" title={highlight.note}>
          {highlight.note}
        </span>
      )}
      <button type="button" className="icon-button" aria-label="Dismiss what the agent points at" title="Dismiss" onClick={dismissHighlight}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
          <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
        </svg>
      </button>
    </div>
  )
}
