export type ViewName = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
export interface Camera { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; ortho: boolean; fov: number; zoom: number }
export interface ViewState { objectId: string; layout: string; camera: Camera; visible: string[] /* part keys */ }
export interface LookRequest { view?: 'current' | ViewName | Camera; layout?: string; parts?: string[] /* names */; size?: number }
/** A picture, and what the window drew to make it: the object it had open, that object's revision, and whether its parts were stale. */
export interface LookResult { png: Uint8Array; width: number; height: number; caption: string; objectId: string; revision: number; stale: boolean }
