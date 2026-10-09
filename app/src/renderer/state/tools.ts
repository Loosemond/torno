import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ShapeKind } from '../../shared/marks'
import type { GizmoMode } from '../viewport/Viewport'

export type ToolName = 'select' | 'pin' | 'arrow' | 'draw' | 'shape'

/** The tools of the palette, in its order. One that is not `ready` is shown, and cannot be chosen yet. */
export const TOOLS: { name: ToolName; label: string; key: string; ready: boolean }[] = [
  { name: 'select', label: 'Select', key: 'V', ready: true },
  { name: 'pin', label: 'Pin', key: 'P', ready: true },
  { name: 'arrow', label: 'Arrow', key: 'A', ready: true },
  { name: 'draw', label: 'Draw', key: 'D', ready: true },
  { name: 'shape', label: 'Shape', key: 'S', ready: true }
]

export type { GizmoMode }

/** The shapes the Shape tool places, in the order they are offered. */
export const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: 'box', label: 'Box' },
  { kind: 'cylinder', label: 'Cylinder' },
  { kind: 'sphere', label: 'Sphere' },
  { kind: 'plane', label: 'Plane' }
]

/** The ways of the gizmo, each with its key. `S` is the Shape tool, which is why sizing is `T`. */
export const GIZMO_MODES: { mode: GizmoMode; label: string; key: string }[] = [
  { mode: 'translate', label: 'Move', key: 'G' },
  { mode: 'rotate', label: 'Rotate', key: 'R' },
  { mode: 'scale', label: 'Size', key: 'T' }
]

interface ToolState {
  /** Which tool the pointer works as in the viewport. */
  tool: ToolName
  /** The shape the Shape tool places: the one last chosen. */
  shape: ShapeKind
  /** What the gizmo on the active shape does. */
  gizmo: GizmoMode
}

/** What the pointer does in the viewport. It changes on a click or a key, never on a pointer move. */
export const toolStore = createStore<ToolState>(() => ({ tool: 'select', shape: 'box', gizmo: 'translate' }))

export function useTool(): ToolName {
  return useZustand(toolStore, (s) => s.tool)
}

export function useShape(): ShapeKind {
  return useZustand(toolStore, (s) => s.shape)
}

export function useGizmo(): GizmoMode {
  return useZustand(toolStore, (s) => s.gizmo)
}

/** Choose the shape the Shape tool places from now on. */
export function setShape(shape: ShapeKind): void {
  toolStore.setState({ shape })
}

/** Choose what the gizmo does. */
export function setGizmo(gizmo: GizmoMode): void {
  toolStore.setState({ gizmo })
}

/** Choose a tool. One that is not ready is not chosen. */
export function setTool(tool: ToolName): void {
  if (TOOLS.find((t) => t.name === tool)?.ready) toolStore.setState({ tool })
}
