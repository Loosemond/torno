import { useEffect, useState } from 'react'
import { partsInLayout, useStore } from '../state/store'
import { BuildErrorSheet } from './BuildErrorSheet'

/** Whole seconds since `startedAt`, counted once a second while a build runs. */
function useElapsed(startedAt: number | undefined): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

/** A duration to a tenth of a second, to whole seconds from ten up; never shown as nothing. */
function seconds(s: number): string {
  return s < 10 ? Math.max(s, 0.1).toFixed(1) : String(Math.round(s))
}

/**
 * The status line: which object, how its last build went, which revision is on
 * screen, and the kernel at the far right. A failed build is a button that
 * opens the error sheet.
 */
export function BuildStatus({ errorOpen, onErrorOpen }: { errorOpen: boolean; onErrorOpen: (open: boolean) => void }) {
  const name = useStore((s) => s.workspace?.objects.find((o) => o.id === s.objectId)?.name ?? s.objectId)
  const build = useStore((s) => s.build)
  const hasScene = useStore((s) => s.scene !== null)
  const partCount = useStore((s) => partsInLayout(s).length)
  const build123d = useStore((s) => s.versions.build123d)
  const building = build?.status === 'building'
  const elapsed = useElapsed(building ? build.startedAt : undefined)
  const error = build?.status === 'failed' ? build.error : undefined

  // The sheet shows the failure of the build it was opened for, no longer.
  useEffect(() => {
    if (errorOpen && !error) onErrorOpen(false)
  }, [errorOpen, error, onErrorOpen])

  return (
    <footer className="status" data-region="status">
      {name === null || !build ? (
        <span>{name === null ? 'No object open' : name}</span>
      ) : (
        <>
          <span className="status-name">{name}</span>
          <span className="status-build" data-status={build.status}>
            <span className="status-dot" aria-hidden="true" />
            {build.status === 'building' && (
              <span>
                Building <span className="num">{elapsed}</span> s
              </span>
            )}
            {build.status === 'ok' && (
              <span>Built{build.seconds !== undefined && <> in <span className="num">{seconds(build.seconds)}</span> s</>}</span>
            )}
            {build.status === 'failed' && (
              <button type="button" className="status-fail" aria-expanded={errorOpen} onClick={() => onErrorOpen(!errorOpen)}>
                Build failed
              </button>
            )}
            {build.status === 'idle' && <span>Not built yet</span>}
          </span>
          {build.revision > 0 && (
            <span data-part="revision">
              {build.stale && 'showing '}
              <span className="num">r{build.revision}</span>
            </span>
          )}
          {hasScene && (
            <span data-part="parts">
              <span className="num">{partCount}</span> {partCount === 1 ? 'part' : 'parts'}
            </span>
          )}
        </>
      )}
      <span className="spacer" />
      {build123d && <span className="num">build123d {build123d}</span>}
      {errorOpen && error && name !== null && (
        <BuildErrorSheet objectName={name} error={error} onClose={() => onErrorOpen(false)} />
      )}
    </footer>
  )
}
