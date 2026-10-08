import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { WorkspaceInfo } from '../shared/workspace'
import { actions, sceneFileOf, store, useStore } from './state/store'
import { BuildStatus } from './ui/BuildStatus'
import { Layers } from './ui/Layers'
import { ObjectList } from './ui/ObjectList'
import { SessionPane } from './ui/SessionPane'
import { DatumMark, ViewportPane } from './ui/ViewportPane'

const LEFT_WIDTH = 248
const DOCK_DEFAULT = 520
const DOCK_MIN = 320
const VIEWPORT_MIN = 240 // free viewport width the dock always leaves beside the left column
const KEY_STEP = 16

function clampDock(width: number): number {
  const max = Math.max(DOCK_MIN, window.innerWidth - LEFT_WIDTH - VIEWPORT_MIN)
  return Math.round(Math.min(Math.max(width, DOCK_MIN), max))
}

const SAVE_DELAY_MS = 500

function showWorkspace(info: WorkspaceInfo | null): void {
  actions.setWorkspace(info)
  if (!info) return
  // The kernel may still be starting: its versions arrive when it is ready.
  window.torno.workspace.versions().then(
    (versions) => {
      if (store.getState().workspace?.root === info.root) actions.setVersions(versions)
    },
    () => {} // a kernel that never started is reported by the first build
  )
}

async function pickWorkspace(): Promise<void> {
  const info = await window.torno.workspace.pick()
  if (info) showWorkspace(info) // null: the dialog was cancelled
}

let opening = 0

/** Show an object as its scene file left it, and have main watch and build it. */
async function openObject(id: string): Promise<void> {
  const turn = ++opening
  const file = await window.torno.object.loadSceneFile(id).catch(() => ({ layers: {} }))
  if (turn !== opening) return // another object was chosen meanwhile
  actions.openObject(id, file)
  try {
    const state = await window.torno.object.open(id)
    // Its build events may have overtaken this answer; they are the newer.
    if (!store.getState().build) actions.applyBuild(state)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    actions.applyBuild({ objectId: id, status: 'failed', revision: 0, stale: false, error: { kind: 'open', message } })
  }
  // Opening scans the folder again: an object made a moment ago is in the list now.
  const info = await window.torno.workspace.current().catch(() => null)
  if (info) actions.refreshWorkspace(info)
}

/** Join the store to main: the workspace at start, build states, and saving the scene file. */
function useMain(): void {
  useEffect(() => {
    let live = true
    void window.torno.workspace.current().then((info) => {
      if (live && !store.getState().workspaceKnown) showWorkspace(info)
    })
    const offBuild = window.torno.object.onBuild(actions.applyBuild)

    // Layer and layout changes are written to <object>/.torno/scene.json, once they stop coming.
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsaved: (() => void) | null = null
    const flush = () => {
      clearTimeout(timer)
      unsaved?.()
      unsaved = null
    }
    const offStore = store.subscribe((s, prev) => {
      if (s.workspace?.root !== prev.workspace?.root) {
        // Main has left that workspace: the object the save was for is no longer there.
        clearTimeout(timer)
        unsaved = null
      } else if (s.objectId !== prev.objectId) {
        flush()
      } else if (s.edits !== prev.edits && s.objectId) {
        const id = s.objectId
        const file = sceneFileOf(s)
        unsaved = () => window.torno.object.saveSceneFile(id, file)
        clearTimeout(timer)
        timer = setTimeout(flush, SAVE_DELAY_MS)
      }
    })
    window.addEventListener('pagehide', flush)

    return () => {
      live = false
      offBuild()
      offStore()
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])
}

export function App() {
  useMain()
  const workspace = useStore((s) => s.workspace)
  const workspaceKnown = useStore((s) => s.workspaceKnown)
  const [errorOpen, setErrorOpen] = useState(false)
  const shell = useRef<HTMLDivElement>(null)
  const [dockWidth, setDockWidth] = useState(DOCK_DEFAULT)
  const [dockOpen, setDockOpen] = useState(true)
  // While the edge is dragged the width goes straight to the CSS variable, so
  // React renders once at the end rather than on every pointer move.
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null)

  function onEdgeDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startWidth: dockWidth, width: dockWidth }
    shell.current!.toggleAttribute('data-resizing', true)
  }

  function onEdgeMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    d.width = clampDock(d.startWidth + d.startX - e.clientX)
    shell.current!.style.setProperty('--dock-w', `${d.width}px`)
  }

  function onEdgeUp() {
    const d = drag.current
    if (!d) return
    drag.current = null
    shell.current!.toggleAttribute('data-resizing', false)
    setDockWidth(d.width)
  }

  function onEdgeKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setDockWidth((w) => clampDock(w + (e.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP)))
  }

  const errorOpened = useCallback((open: boolean) => setErrorOpen(open), [])
  const revealDock = useCallback(() => setDockOpen(true), [])

  if (!workspaceKnown) return <div className="shell" />
  if (!workspace) {
    return (
      <div className="shell">
        <main className="viewport welcome" data-region="viewport">
          <DatumMark />
          <h1 className="wordmark">torno</h1>
          <p>Open the folder that holds your objects. Each object is a folder with a Python model in it.</p>
          <button type="button" className="button button-primary" onClick={() => void pickWorkspace()}>
            Open folder
          </button>
        </main>
      </div>
    )
  }

  return (
    <div
      ref={shell}
      className="shell"
      data-dock={dockOpen ? 'open' : 'collapsed'}
      style={{ '--dock-w': `${dockWidth}px` } as CSSProperties}
    >
      <main className="viewport" data-region="viewport">
        <ViewportPane onShowError={() => setErrorOpen(true)} />
      </main>

      <aside className="left" data-region="left" aria-label="Objects and layers">
        <header className="panel-head">
          <h1 className="workspace-name" title={workspace.root}>
            {basename(workspace.root)}
          </h1>
          <button type="button" className="icon-button" aria-label="Open folder" title="Open folder" onClick={() => void pickWorkspace()}>
            <FolderIcon />
          </button>
        </header>
        <ObjectList onOpen={(id) => void openObject(id)} />
        <Layers />
      </aside>

      <aside className="dock" data-region="session" aria-label="Session" hidden={!dockOpen}>
        <div
          className="dock-edge"
          role="separator"
          aria-label="Resize session"
          aria-orientation="vertical"
          aria-valuenow={dockWidth}
          aria-valuemin={DOCK_MIN}
          tabIndex={0}
          onPointerDown={onEdgeDown}
          onPointerMove={onEdgeMove}
          onPointerUp={onEdgeUp}
          onPointerCancel={onEdgeUp}
          onKeyDown={onEdgeKey}
        />
        <SessionPane onReveal={revealDock} />
      </aside>

      <button
        type="button"
        className="dock-toggle"
        aria-label={dockOpen ? 'Hide session' : 'Show session'}
        aria-expanded={dockOpen}
        title={dockOpen ? 'Hide session' : 'Show session'}
        onClick={() => setDockOpen((open) => !open)}
      >
        <DockIcon />
      </button>

      <BuildStatus errorOpen={errorOpen} onErrorOpen={errorOpened} />
    </div>
  )
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.6l1.5 1.75h5.4c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5v-7.5Z" />
    </svg>
  )
}

function DockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
      <path d="M10 2.75v10.5" />
    </svg>
  )
}
