import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'

export type ToolName = 'select' | 'pin' | 'arrow' | 'draw' | 'shape'

/** The tools of the palette, in its order. One that is not `ready` is shown, and cannot be chosen yet. */
export const TOOLS: { name: ToolName; label: string; key: string; ready: boolean }[] = [
  { name: 'select', label: 'Select', key: 'V', ready: true },
  { name: 'pin', label: 'Pin', key: 'P', ready: true },
  { name: 'arrow', label: 'Arrow', key: 'A', ready: true },
  { name: 'draw', label: 'Draw', key: 'D', ready: false },
  { name: 'shape', label: 'Shape', key: 'S', ready: false }
]

/** Which tool the pointer works as in the viewport. It changes on a click or a key, never on a pointer move. */
export const toolStore = createStore<{ tool: ToolName }>(() => ({ tool: 'select' }))

export function useTool(): ToolName {
  return useZustand(toolStore, (s) => s.tool)
}

/** Choose a tool. One that is not ready is not chosen. */
export function setTool(tool: ToolName): void {
  if (TOOLS.find((t) => t.name === tool)?.ready) toolStore.setState({ tool })
}
