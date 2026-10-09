import { useEffect, useRef, useState } from 'react'
import type { Scene } from '../../shared/scene'
import type { LookRequest, LookResult } from '../../shared/view'
import { describe, descriptorOf } from '../state/descriptors'
import { actions, partsInLayout, store, useStore, visibleKeys, type TornoState } from '../state/store'
import { toolStore, type ToolHandler, type ToolName } from '../state/tools'
import { Readout } from '../viewport/highlight'
import { Viewport, type ViewportPointer } from '../viewport/Viewport'
import { Selection } from './Selection'
import { ToolPalette } from './ToolPalette'
import { ViewBar } from './ViewBar'

const NO_SCENE: Scene = { model: '', layouts: [], parts: [], seconds: 0, output: '' }

/**
 * A picture of the open object for the agent. `parts` are names in the layout
 * asked for (the one shown, by default); without them, the parts switched on.
 * The answer names the object, the revision and whether the parts were stale,
 * all read in the turn the picture is drawn in: a build that lands while the
 * PNG is being made does not change what the picture is said to be of.
 */
async function look(viewport: Viewport, req: LookRequest): Promise<LookResult> {
  let drawn: { objectId: string; revision: number; stale: boolean } | undefined
  const picture = await viewport.renderImage(() => {
    const s = store.getState()
    if (!s.objectId || !s.scene) throw new Error('no build yet')
    const layout = req.layout ?? s.layout
    let keys = visibleKeys(s, layout)
    if (req.parts) {
      const parts = partsInLayout(s, layout)
      // An unknown layout is left to the viewport, whose error names the layouts.
      const known = s.scene.layouts.includes(layout)
      keys = []
      for (const name of req.parts) {
        const part = parts.find((p) => p.name === name)
        if (part) keys.push(part.key)
        else if (known) throw new Error(`unknown part '${name}'; parts in layout ${layout}: ${parts.map((p) => p.name).join(', ')}`)
      }
    }
    drawn = { objectId: s.objectId, revision: s.revision, stale: s.build?.stale ?? false }
    return { view: req.view ?? 'current', layout, visibleKeys: keys, size: req.size }
  })
  return { ...picture, ...drawn! }
}

/** How long the pointer rests on a face or an edge before the kernel is asked what it is. */
const DESCRIBE_AFTER_MS = 150
/** Said at the pointer while the parts on screen are older than the model: their refs would name the wrong geometry. */
const STALE_MESSAGE = 'Rebuilding: picks wait for the new build'

/**
 * The select tool: what is under the pointer is marked and named beside it,
 * a click selects it, with Shift adds it or takes it out, and a click on
 * nothing clears the selection. Dragging turns the camera as ever.
 */
function selectTool(viewport: Viewport, readout: Readout): ToolHandler {
  let hovered: string | null = null
  let rest: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(rest)
    hovered = null
    viewport.setHover(null)
    readout.hide()
  }
  return {
    stop,
    pointer(e: ViewportPointer) {
      if (e.type === 'click') {
        if (!e.hit) actions.setSelection([])
        else if (e.shift) actions.toggleSelection(e.hit.ref)
        else actions.setSelection([e.hit.ref])
        return
      }
      const { hit } = e
      const { objectId, revision, layout } = store.getState()
      if (e.type === 'cancel' || !hit || !objectId) return stop()

      const { ref } = hit
      hovered = ref
      viewport.setHover(hit)
      const known = descriptorOf(objectId, revision, layout, ref)
      readout.show(e.client, ref, known)
      clearTimeout(rest)
      if (known !== undefined) return
      rest = setTimeout(() => {
        void describe(objectId, revision, layout, ref).then((text) => {
          if (text !== null && hovered === ref && store.getState().revision === revision) readout.describe(text)
        })
      }, DESCRIBE_AFTER_MS)
    }
  }
}

/** Join a viewport to the store and to main. Returns what undoes it. */
function connect(viewport: Viewport, readout: Readout): () => void {
  const applyLayers = (s: TornoState) => {
    // Every part, each time: the viewport remembers settings by key, and keys repeat between objects.
    for (const part of s.scene?.parts ?? []) {
      const layer = s.layers[part.name]
      viewport.setLayer(part.key, { visible: layer?.visible !== false, color: layer?.color, opacity: layer?.opacity ?? 1 })
    }
  }
  const report = () => {
    const s = store.getState()
    if (!s.objectId || !s.scene) return
    window.torno.view.report({ objectId: s.objectId, layout: s.layout, camera: viewport.getCamera(), visible: visibleKeys(s) })
  }

  const offScene = window.torno.object.onScene((m) => {
    const first = store.getState().scene === null
    if (!actions.applyScene(m)) return
    const s = store.getState()
    applyLayers(s)
    viewport.setScene(m.scene, m.blob)
    viewport.setLayout(s.layout)
    viewport.setStale(s.build?.stale ?? false)
    if (first) viewport.setView('iso')
    report()
  })

  // The one pointer subscription: every event goes to the tool in use, and to
  // none while the parts are stale. Tools made by later tasks are added here.
  const handlers: Partial<Record<ToolName, ToolHandler>> = { select: selectTool(viewport, readout) }
  let tool = handlers[toolStore.getState().tool]
  const putDown = () => {
    tool?.stop()
    readout.hide()
    viewport.setNavigation(true)
  }
  const offTool = toolStore.subscribe((t) => {
    putDown()
    tool = handlers[t.tool]
  })
  viewport.onPointer((e) => {
    const s = store.getState()
    if (!s.scene) return
    if (!s.build?.stale) return tool?.pointer(e)
    // Refs of the old build would name other faces in the new one: nothing is picked.
    if (e.hit) readout.say(e.client, STALE_MESSAGE)
    else readout.hide()
  })

  const offStore = store.subscribe((s, prev) => {
    if (s.selection !== prev.selection) viewport.setSelection(s.selection)
    // What was pointed at belongs to the object, the layout and the build it was pointed at in.
    if (s.objectId !== prev.objectId || s.layout !== prev.layout || s.revision !== prev.revision || (s.build?.stale ?? false) !== (prev.build?.stale ?? false)) putDown()
    if (s.objectId !== prev.objectId || (prev.scene && !s.scene)) {
      viewport.setScene(NO_SCENE, new ArrayBuffer(0))
      viewport.setStale(false)
      return
    }
    if (s.scene !== prev.scene) return // the scene handler above brings the viewport in line
    if (s.build !== prev.build) viewport.setStale((s.build?.stale ?? false) && s.scene !== null)
    if (s.layout !== prev.layout) viewport.setLayout(s.layout)
    if (s.layers !== prev.layers) applyLayers(s)
    if (s.layout !== prev.layout || s.layers !== prev.layers) report()
  })

  viewport.onCameraSettled((camera) => {
    if (camera.ortho !== store.getState().ortho) actions.setOrtho(camera.ortho)
    report()
  })

  const offLook = window.torno.view.onLook(({ id, request }) => {
    look(viewport, request).then(
      (result) => window.torno.view.lookReply(id, result),
      (e: unknown) => window.torno.view.lookReply(id, { error: e instanceof Error ? e.message : String(e) })
    )
  })

  if (new URLSearchParams(location.search).has('test')) {
    window.__tornoTest = {
      state: () => store.getState(),
      look: (req) => look(viewport, req),
      camera: () => viewport.getCamera(),
      pickAt: (fx, fy, opts) => {
        const box = canvasBox(viewport)
        return viewport.pick(box.left + fx * box.width, box.top + fy * box.height, opts)
      },
      project: (point) => {
        const box = canvasBox(viewport)
        const [x, y] = viewport.project(point)
        return [(x - box.left) / box.width, (y - box.top) / box.height]
      }
    }
  }

  return () => {
    offTool()
    offScene()
    offStore()
    offLook()
    delete window.__tornoTest
  }
}

function canvasBox(viewport: Viewport): DOMRect {
  return viewport.canvas.getBoundingClientRect()
}

/**
 * The 3D view of the open object, in the part of the window no panel covers,
 * with the view bar floating on it. What to say when there is nothing to draw
 * is here too.
 */
export function ViewportPane({ onShowError }: { onShowError: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const name = useStore((s) => s.workspace?.objects.find((o) => o.id === s.objectId)?.name ?? s.objectId)
  const hasScene = useStore((s) => s.scene !== null)
  const build = useStore((s) => s.build)

  useEffect(() => {
    // A canvas of its own for each viewport: a WebGL context is not handed on.
    const canvas = document.createElement('canvas')
    host.current!.append(canvas)
    let made: Viewport
    try {
      made = new Viewport(canvas)
    } catch (e) {
      canvas.remove()
      setFailure(e instanceof Error ? e.message : String(e))
      return
    }
    const readout = new Readout(host.current!)
    const disconnect = connect(made, readout)
    const sized = new ResizeObserver(() => made.resize())
    sized.observe(host.current!)
    setViewport(made)
    return () => {
      sized.disconnect()
      disconnect()
      readout.dispose()
      made.dispose()
      canvas.remove()
      setViewport(null)
    }
  }, [])

  const error = build?.status === 'failed' ? build.error : undefined
  const hasDetails = Boolean(error?.traceback?.trim() || error?.output?.trim())

  return (
    <div className="viewport-pane">
      {/* Always laid out, so the camera is fitted to its real shape; what is said below covers it. */}
      <div className="viewport-canvas" ref={host} />
      {viewport && hasScene && (
        <>
          <ViewBar viewport={viewport} />
          <ToolPalette />
          <Selection />
        </>
      )}
      {!hasScene && (
        <div className="viewport-empty">
          <DatumMark />
          {failure !== null ? (
            <>
              <h2>The 3D view could not start</h2>
              <p className="selectable">{failure}</p>
            </>
          ) : name === null ? (
            <>
              <h2>No object open</h2>
              <p>Choose an object in the left column to see its parts here.</p>
            </>
          ) : error ? (
            <>
              <h2>{name} did not build</h2>
              <p className="selectable" data-part="reason">{error.message}</p>
              {hasDetails && (
                <button type="button" className="button" onClick={onShowError}>
                  Show the error
                </button>
              )}
            </>
          ) : (
            <>
              <h2>Building {name}</h2>
              <p>Its parts appear here when the build finishes.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** A scribed centre mark: where the part's origin will sit on the plate. */
export function DatumMark() {
  return (
    <svg className="datum" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <circle cx="22" cy="22" r="9.5" />
      <path d="M22 2.5v15M22 26.5v15M2.5 22h15M26.5 22h15" />
      <circle cx="22" cy="22" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
