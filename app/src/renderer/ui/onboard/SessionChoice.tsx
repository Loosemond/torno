import { useEffect, useState } from 'react'
import { type AgentChoice, type ChatModel, type Effort, MODEL_ALIASES, effortsOf, isEffort } from '../../../shared/chat'
import { EFFORT_LABEL } from '../chat/EffortMenu'
import { chosen, pointerChoice } from '../typing'

/**
 * The model and effort Claude Code starts the new object's session on, beside Create: for that session alone, never
 * written to the person's settings. "Your default" passes nothing, and the CLI goes by their settings. The models are
 * the ones the last chat's CLI offered (`chat.models`), or Claude Code's aliases before any has; the efforts, the ones
 * the chosen model takes (every one when the CLI did not say). An effort the model chosen does not take is let go.
 */
export function SessionChoice({ choice, disabled, onChange }: { choice: AgentChoice; disabled: boolean; onChange: (choice: AgentChoice) => void }) {
  const [models, setModels] = useState<readonly ChatModel[]>(MODEL_ALIASES)
  useEffect(() => {
    let live = true
    window.torno.chat.models().then(
      (list) => live && list.length > 0 && setModels(list),
      () => {}
    )
    return () => {
      live = false
    }
  }, [])
  // The person's default model is the CLI's `default` row, when its list has one.
  const efforts = effortsOf(models, choice.model ?? 'default')
  // A model kept from an earlier list stays shown as it is.
  const listed = choice.model === undefined || models.some((m) => m.value === choice.model)
  const effortOff = efforts.length === 0

  useEffect(() => {
    if (choice.effort !== undefined && !efforts.includes(choice.effort)) onChange({ ...choice, effort: undefined })
  }, [choice, efforts, onChange])

  return (
    <div className="new-choice" role="group" aria-label="Claude Code starts on">
      <span className="new-choice-label">Claude Code on</span>
      <select
        className="new-select num"
        aria-label="Model"
        title="The model of this object's first session. It does not change your settings"
        value={choice.model ?? ''}
        disabled={disabled}
        {...pointerChoice}
        onChange={(e) => {
          onChange({ ...choice, model: e.target.value === '' ? undefined : e.target.value })
          chosen(e.currentTarget)
        }}
      >
        <option value="">Your default model</option>
        {!listed && <option value={choice.model}>{choice.model}</option>}
        {models
          .filter((m) => m.value !== 'default')
          .map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName}
            </option>
          ))}
      </select>
      <select
        className="new-select"
        aria-label="Effort"
        title={effortOff ? 'This model takes no effort level' : 'How hard Claude thinks in this session. It does not change your settings'}
        value={choice.effort ?? ''}
        disabled={disabled || effortOff}
        {...pointerChoice}
        onChange={(e) => {
          const value = e.target.value
          onChange({ ...choice, effort: isEffort(value) ? (value as Effort) : undefined })
          chosen(e.currentTarget)
        }}
      >
        <option value="">Your default effort</option>
        {efforts.map((one) => (
          <option key={one} value={one}>
            {EFFORT_LABEL[one]}
          </option>
        ))}
      </select>
    </div>
  )
}
