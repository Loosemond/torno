import type { AgentId } from '../../shared/bridge'
import { chosen, pointerChoice } from './typing'

/** An agent there is to choose, and whether its command is on PATH. */
export interface AgentChoice {
  id: AgentId
  label: string
  installed: boolean
  hooks: boolean
}

/**
 * The agent that the sessions of the open object run, in the session header.
 * One whose command is not installed is listed, and cannot be chosen.
 * `onOpen` is when the list is about to be shown: what is installed is asked
 * again then.
 */
export function AgentPicker(props: { value: AgentId; agents: readonly AgentChoice[]; disabled?: boolean; onOpen: () => void; onChoose: (agent: AgentId) => void }) {
  return (
    <select
      className="agent-picker"
      aria-label="Agent"
      title="The agent that sessions of this object run"
      value={props.value}
      disabled={props.disabled}
      onFocus={props.onOpen}
      onPointerDown={(e) => {
        pointerChoice.onPointerDown(e)
        props.onOpen()
      }}
      onKeyDown={pointerChoice.onKeyDown}
      onChange={(e) => {
        props.onChoose(e.target.value as AgentId)
        chosen(e.currentTarget)
      }}
    >
      {props.agents.map((agent) => (
        <option key={agent.id} value={agent.id} disabled={!agent.installed}>
          {agent.installed ? agent.label : `${agent.label} (not installed)`}
        </option>
      ))}
    </select>
  )
}
