import { useEffect, useState } from 'react'
import type { GitState } from '../../shared/git'
import { useStore } from '../state/store'

/**
 * What git says of the open object's sources (read by main, never written): asked when the object is opened,
 * when a build of it lands or fails, and when the window is focused again (a commit made in a terminal changes
 * nothing torno watches). Null where there is no git or no repository, and until it has answered.
 */
export function useGit(): GitState | null {
  const objectId = useStore((s) => s.objectId)
  const status = useStore((s) => s.build?.status)
  const revision = useStore((s) => s.build?.revision)
  const [git, setGit] = useState<{ of: string; state: GitState | null } | null>(null)
  const [focused, setFocused] = useState(0)

  useEffect(() => {
    const again = (): void => setFocused((n) => n + 1)
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [])

  useEffect(() => {
    if (objectId === null || status === 'building') return
    let current = true
    window.torno.git.status(objectId).then(
      (state) => current && setGit({ of: objectId, state }),
      () => current && setGit({ of: objectId, state: null })
    )
    return () => {
      current = false
    }
  }, [objectId, status, revision, focused])

  return git !== null && git.of === objectId ? git.state : null
}
