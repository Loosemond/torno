import { memo, useMemo } from 'react'
import type { ChatItem } from '../../../shared/chat'
import { numbered } from '../numbered'
import { type Task, progress, tasksNow } from './tasks'

/** The agent's tasks as a checklist: a mark for each state, what it is doing in the words of "doing" while it does it. */
function Checklist({ list }: { list: readonly Task[] }) {
  return (
    <ul className="chat-tasks-list">
      {list.map((task) => (
        <li key={task.id} className="chat-task" data-status={task.status}>
          <span className="chat-task-mark" aria-hidden="true" />
          <span className="chat-task-text">{numbered(task.status === 'in_progress' && task.active ? task.active : task.text)}</span>
          <span className="chat-task-state">{task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'in progress' : ''}</span>
        </li>
      ))}
    </ul>
  )
}

function Head({ list }: { list: readonly Task[] }) {
  const { done, all } = progress(list)
  return (
    <p className="chat-tasks-head">
      <span>Tasks</span>
      <span className="chat-tasks-count">{numbered(`${done} of ${all} done`)}</span>
    </p>
  )
}

/** The agent's list as it stood at one of its calls, in place in the transcript. */
export const TasksCard = memo(function TasksCard({ list }: { list: readonly Task[] }) {
  return (
    <div className="chat-item chat-tasks" data-kind="tasks">
      <Head list={list} />
      {list.length > 0 && <Checklist list={list} />}
    </div>
  )
})

/**
 * The agent's list as it stands, above the box, while the turn runs and the list has a task left; nothing otherwise.
 * It is read from the cards of the transcript (`tasksNow`) and kept nowhere.
 */
export function TasksBar({ items, working }: { items: readonly ChatItem[]; working: boolean }) {
  const list = useMemo(() => tasksNow(items), [items])
  if (!working || list.length === 0 || list.every((task) => task.status === 'completed')) return null
  return (
    <div className="chat-tasks chat-tasks-bar" role="region" aria-label="The agent's tasks">
      <Head list={list} />
      <Checklist list={list} />
    </div>
  )
}
