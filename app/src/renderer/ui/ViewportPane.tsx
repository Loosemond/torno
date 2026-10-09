import { useEffect, useRef, useState } from 'react'
import type { Scene } from '../../shared/scene'
import { type LookRequest, type LookResult, type SectionPlane, type ViewState, MAX_SELECTION_REPORTED, NOT_A_PLANE, sectionOf } from '../../shared/view'
import { connectAgent, picture, setPictures } from '../state/agent'
import { describe, describeWhole, descriptorOf } from '../state/descriptors'
import { actions, partsInLayout, store, useStore, visibleKeys, type TornoState } from '../state/store'
import { endReplace, setTool, toolStore, type ToolName } from '../state/tools'
import { arrowTool } from '../tools/arrowTool'
import { drawTool } from '../tools/drawTool'
import { measureTool } from '../tools/measureTool'
import { commitMark, replaceMark } from '../tools/pickMarks'
import { pinTool } from '../tools/pinTool'
import { sectionTool } from '../tools/sectionTool'
import { selectTool } from '../tools/selectTool'
import { connectShapeEdit, shapeTool } from '../tools/shapeTool'
import { routePointer, staleMessage, type Tool, type ToolContext } from '../tools/Tool'
import { Readout } from '../viewport/highlight'
import { Viewport } from '../viewport/Viewport'
import { AgentLine } from './AgentLine'
import { NotePopover } from './NotePopover'
import { SectionBar } from './SectionBar'
import { Selection } from './Selection'
import { ToolPalette } from './ToolPalette'
import { TYPING } from './typing'
import { ViewBar } from './ViewBar'

const NO_SCENE: Scene = { model: '', layouts: [], parts: [], seconds: 0, output: '' }

/**
 * A picture of the open object for the agent. `parts` are names in the layout
 * asked for (the one shown, by default); without them, the parts switched on.
 * They are cut as on screen unless the request says otherwise: by a plane of
 * its own, or by none. The answer names the object, the revision and whether the parts were stale,
 * all read in the turn the picture is drawn in: a build that lands while the
 * PNG is being made does not change what the picture is said to be of.
 */
async function look(viewport: Viewport, req: LookRequest): Promise<LookResult> {
  let drawn: { objectId: string; revision: number; stale: boolean } | undefined
  let section: SectionPlane | 'current' | null = 'current'
  if (req.section === null) section = null
  else if (req.section !== undefined && req.section !== 'current') {
    section = sectionOf(req.section)
    if (!section) throw new Error(NOT_A_PLANE)
  }
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
    return { view: req.view ?? 'current', layout, visibleKeys: keys, size: req.size, marks: req.marks ?? true, section }
  })
  return { ...picture, ...drawn! }
}

/**
 * The mark the pin tool is in hand to put somewhere else, when it can be: a
 * mark of the open object that is not resolved, in the layout shown. Null otherwise.
 */
function replacingIn(s: TornoState): string | null {
  const replacing = toolStore.getState().replacing
  if (!replacing || replacing.objectId !== s.objectId) return null
  const mark = s.marks.find((m) => m.id === replacing.id)
  return mark && mark.status !== 'resolved' && mark.layout === s.layout ? mark.id : null
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
    const view: ViewState = { objectId: s.objectId, layout: s.layout, camera: viewport.getCamera(), visible: visibleKeys(s), ...(s.section ? { section: s.section } : {}) }
    // What is selected goes to the agent with the next prompt: the refs, each with the kernel's line once it has come.
    if (s.selection.length > 0) {
      const { objectId, revision, layout } = s
      const refs = s.selection.slice(0, MAX_SELECTION_REPORTED).map((ref) => {
        const descriptor = descriptorOf(objectId, revision, layout, ref)
        return descriptor === undefined ? { ref } : { ref, descriptor }
      })
      view.selection = { revision, total: s.selection.length, refs }
    }
    window.torno.view.report(view)
  }
  /** Says what is selected now, and again once the kernel has said what each of it is. */
  const reportSelection = (s: TornoState) => {
    report()
    const { objectId, revision, layout, selection } = s
    if (!objectId || selection.length === 0) return
    const asked = selection.slice(0, MAX_SELECTION_REPORTED).filter((ref) => descriptorOf(objectId, revision, layout, ref) === undefined)
    if (asked.length === 0) return
    void Promise.all(asked.map((ref) => describe(objectId, revision, layout, ref))).then(() => {
      if (store.getState().selection === selection) report()
    })
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

  // What a tool works with, as things are now. `commit` and the kernel's
  // answers belong to the object, layout and build of that moment.
  const context = (): ToolContext => {
    const s = store.getState()
    const { layout, revision } = s
    const objectId = s.objectId ?? ''
    return {
      viewport,
      readout,
      objectId,
      layout,
      revision,
      get camera() {
        return viewport.getCamera()
      },
      stale: s.build?.stale ? staleMessage(s.build.status) : null,
      descriptor: (ref) => descriptorOf(objectId, revision, layout, ref),
      describe: (ref) => describeWhole(objectId, revision, layout, ref),
      commit: (mark) => commitMark(objectId, mark),
      moved: (part) => s.scene?.parts.some((p) => p.layout === layout && p.name === part && p.arranged !== undefined) === true,
      openNote: (mark) => actions.openNote({ objectId, layout: mark.layout, id: mark.id }),
      replacing: replacingIn(s),
      replace: (id, placed) => replaceMark(objectId, id, placed),
      endReplace
    }
  }

  // The one pointer subscription: every event goes to the tool in use, and to
  // none while the parts are stale (`routePointer`). Tools made by later tasks are added here.
  const tools: Partial<Record<ToolName, Tool>> = { select: selectTool(), pin: pinTool(), arrow: arrowTool(), draw: drawTool(), shape: shapeTool(), section: sectionTool(), measure: measureTool() }
  let tool = tools[toolStore.getState().tool]
  const putDown = () => {
    tool?.cancel(context())
    readout.hide()
    viewport.setNavigation(true)
  }
  const pickUp = () => {
    tool = tools[toolStore.getState().tool]
    viewport.canvas.style.cursor = tool?.cursor ?? ''
    // The plane of a section has its handle while it is the pointer's to drag.
    viewport.showSectionHandle(tool?.id === 'section')
  }
  pickUp()
  const offTool = toolStore.subscribe(() => {
    putDown()
    pickUp()
  })
  viewport.onPointer((e) => {
    if (tool && store.getState().scene) routePointer(tool, e, context())
  })
  // Keys outside any field: the tool in use first, then Escape puts a mark tool down for Select.
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.target instanceof Element && e.target.closest(TYPING)) return
    if (tool?.onKey?.(e, context())) return e.preventDefault()
    if (e.key !== 'Escape' || toolStore.getState().tool === 'select') return
    setTool('select')
    e.preventDefault()
  }
  window.addEventListener('keydown', onKey)

  /** The build on show, as the dimensions' values are held against it: none until there is a scene. */
  const shown = (s: ReturnType<typeof store.getState>): number => (s.scene ? s.revision : 0)
  viewport.setMarks(store.getState().marks, shown(store.getState()))
  viewport.setActiveMark(store.getState().activeMark)
  viewport.setSection(store.getState().section)
  // The gizmo on the active mark while it is a shape, and the keys that say what it does.
  const offShape = connectShapeEdit(viewport)

  const offStore = store.subscribe((s, prev) => {
    // A mark that can no longer be put somewhere else here (it is gone, resolved, or of another layout or object) is left be.
    if (toolStore.getState().replacing && replacingIn(s) === null) endReplace()
    if (s.selection !== prev.selection) viewport.setSelection(s.selection)
    // The cut is of the object: another object has its own, or none.
    if (s.section !== prev.section) viewport.setSection(s.section)
    if (s.selection !== prev.selection && s.objectId === prev.objectId && s.scene === prev.scene && s.layout === prev.layout) reportSelection(s)
    if (s.marks !== prev.marks || shown(s) !== shown(prev)) viewport.setMarks(s.marks, shown(s))
    if (s.activeMark !== prev.activeMark) viewport.setActiveMark(s.activeMark)
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
    if (s.layout !== prev.layout || s.layers !== prev.layers || s.section !== prev.section) report()
    // After the layout: a mark of another layout is gone to once that layout is shown.
    if (s.markFocus !== prev.markFocus && s.activeMark) viewport.focusMark(s.activeMark)
  })

  viewport.onCameraSettled((camera) => {
    if (camera.ortho !== store.getState().ortho) actions.setOrtho(camera.ortho)
    actions.setLockedView(viewport.lockedView())
    report()
  })

  // What the agent asks of the window besides pictures: to show something, and to point something out.
  const offAgent = connectAgent(viewport)

  // Main's requests for a picture are answered by the app (`connectLook`), with this viewport while it is there.
  setPictures((request) => look(viewport, request))

  if (new URLSearchParams(location.search).has('test')) {
    window.__tornoTest = {
      state: () => store.getState(),
      look: (req) => picture(req),
      camera: () => viewport.getCamera(),
      pickAt: (fx, fy, opts) => {
        const box = canvasBox(viewport)
        return viewport.pick(box.left + fx * box.width, box.top + fy * box.height, opts)
      },
      project: (point) => {
        const box = canvasBox(viewport)
        const [x, y] = viewport.project(point)
        return [(x - box.left) / box.width, (y - box.top) / box.height]
      },
      timePicks: (count = 200, opts) => {
        // What a pointer move costs: the same call, at points spread over the canvas in a grid.
        const box = canvasBox(viewport)
        const side = Math.ceil(Math.sqrt(count))
        let worst = 0
        let hits = 0
        const started = performance.now()
        for (let i = 0; i < count; i++) {
          const fx = ((i % side) + 0.5) / side
          const fy = (Math.floor(i / side) + 0.5) / side
          const before = performance.now()
          if (viewport.pick(box.left + fx * box.width, box.top + fy * box.height, opts)) hits += 1
          worst = Math.max(worst, performance.now() - before)
        }
        return { count, hits, meanMs: (performance.now() - started) / count, worstMs: worst }
      },
      timeFrames: (count = 20) => {
        // What drawing the view as it is costs: each frame waited for until the graphics card has finished it.
        const gl = viewport.canvas.getContext('webgl2')
        const draw = (viewport as unknown as { draw(): void }).draw.bind(viewport)
        let worst = 0
        const started = performance.now()
        for (let i = 0; i < count; i++) {
          const before = performance.now()
          draw()
          gl?.finish()
          worst = Math.max(worst, performance.now() - before)
        }
        return { count, meanMs: (performance.now() - started) / Math.max(count, 1), worstMs: worst }
      },
      markScreen: (id) => {
        const box = canvasBox(viewport)
        const label = viewport.markLabel(id)
        return label && { x: (label.x - box.left) / box.width, y: (label.y - box.top) / box.height, visible: label.visible }
      }
    }
  }

  return () => {
    putDown()
    window.removeEventListener('keydown', onKey)
    offTool()
    offScene()
    offStore()
    offShape()
    setPictures(null)
    offAgent()
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
          <Selection viewport={viewport} />
          <SectionBar viewport={viewport} />
          <AgentLine />
          <NotePopover viewport={viewport} />
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
