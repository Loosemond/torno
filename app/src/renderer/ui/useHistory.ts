import { useEffect, useState } from 'react'
import type { HistoryList } from '../../shared/history'
import { useStore } from '../state/store'

/**
 * The builds kept of the open object (`main/history.ts`), oldest first: asked when it is opened, whenever main says its
 * history changed, and when a build of it lands. Undefined until main has answered; null for an object it does not know.
 * Only while `active`: the history is read when the sheet is up, not at every build.
 */
export function useHistory(active: boolean): HistoryList | null | undefined {
  const objectId = useStore((s) => s.objectId)
  const revision = useStore((s) => s.build?.revision)
  const [list, setList] = useState<{ of: string; list: HistoryList | null } | undefined>(undefined)
  const [told, setTold] = useState(0)

  useEffect(() => {
    if (!active) return
    return window.torno.history.onChanged((id) => id === objectId && setTold((n) => n + 1))
  }, [active, objectId])

  useEffect(() => {
    if (!active || objectId === null) return
    let current = true
    window.torno.history.list(objectId).then(
      (found) => current && setList({ of: objectId, list: found }),
      () => current && setList({ of: objectId, list: null })
    )
    return () => {
      current = false
    }
  }, [active, objectId, revision, told])

  return list !== undefined && list.of === objectId ? list.list : undefined
}
