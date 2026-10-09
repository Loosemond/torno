import type { SectionPlane } from './view'

/** What a person set for one part: anything left out has its default (shown, palette colour, opaque). */
export interface LayerSettings { visible?: boolean; color?: string; opacity?: number }

/** `<object>/.torno/scene.json`: how an object was last looked at. `layers` is keyed by part name; `section` is the plane it was cut by, left out or null for none. */
export interface SceneFile { layout?: string; layers: Record<string, LayerSettings>; section?: SectionPlane | null }
