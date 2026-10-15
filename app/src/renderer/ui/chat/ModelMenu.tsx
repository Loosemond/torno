import { useEffect, useState } from 'react'
import type { ChatModel } from '../../../shared/chat'
import { chosen, pointerChoice } from '../typing'

/**
 * The model of a chat session, and the ones the CLI said it offers. A choice is sent to the CLI for this session
 * only (`set_model`): the person's own settings are not written. The model shown is the one the CLI last said it
 * runs; one that is none of the list (the full name of a model the list names by an alias) stands as it is. A choice
 * stays shown until the CLI says which model it runs next (it does at its next prompt).
 */
export function ModelMenu({ sessionId, model, models, live }: { sessionId: string; model: string | undefined; models: readonly ChatModel[]; live: boolean }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  useEffect(() => setPicked(undefined), [model])
  const shown = picked ?? model
  const listed = shown !== undefined && models.some((m) => m.value === shown)
  return (
    <>
      <select
        className="session-model num"
        aria-label="Model"
        title="The model of this session. A choice here does not change your settings"
        value={shown ?? ''}
        disabled={!live}
        onPointerDown={pointerChoice.onPointerDown}
        onKeyDown={pointerChoice.onKeyDown}
        onChange={(e) => {
          setProblem(null)
          setPicked(e.target.value)
          window.torno.chat.setModel(sessionId, e.target.value).catch((err: unknown) => {
            setPicked(undefined)
            setProblem((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))
          })
          chosen(e.currentTarget)
        }}
      >
        {shown === undefined && (
          <option value="" disabled>
            Model
          </option>
        )}
        {shown !== undefined && !listed && <option value={shown}>{shown}</option>}
        {models.map((m) => (
          <option key={m.value} value={m.value}>
            {m.displayName}
          </option>
        ))}
      </select>
      {problem !== null && (
        <span className="chat-problem selectable" role="alert">
          {problem}
        </span>
      )}
    </>
  )
}
