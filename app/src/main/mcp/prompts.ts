import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/** How the agent's client names a tool of torno's to its model; Claude Code's, as `contextFor` takes when nothing says. */
export type ToolName = (tool: string) => string
const CLAUDE_TOOL: ToolName = (tool) => `mcp__torno__${tool}`

/** A bed given as `256x256x256` (or `256 x 256 x 256`, `×`), in mm: three positive sizes, else undefined. */
export function parseBed(text: string): [number, number, number] | undefined {
  const parts = text.trim().split(/\s*[x×*,]\s*|\s+/i)
  if (parts.length !== 3) return undefined
  const sizes = parts.map(Number)
  return sizes.every((n) => Number.isFinite(n) && n > 0) ? (sizes as [number, number, number]) : undefined
}

/** The requests that come up again and again, as MCP prompts: a client lists them as slash commands (`/mcp__torno__<name>`). */
export const PROMPTS = {
  review: {
    description: 'Go through every open mark and every unmet dimension against the current build: measure, look, and resolve the marks that are done.',
    text: (toolName: ToolName): string =>
      [
        `Review the open marks and the dimensions of this project against the current build.`,
        ``,
        `1. Call ${toolName('scene')} for the build status and revision, and ${toolName('marks')} for every open mark and every dimension that fails or is not measured.`,
        `2. For each open mark, read its note and its anchor, then say whether the current build meets it. Where it is about a size, a fit or a wall, measure it with ${toolName('measure')} (or ${toolName('check')} for a clearance or an overlap) rather than reading it off the model's code; ${toolName('describe')} tells what a ref is.`,
        `3. Look with ${toolName('look')} once or twice, at views that show all the open marks, with the marks drawn; look at one mark alone only where the numbers cannot settle it.`,
        `4. For each dimension that fails or is not measured, say what it wants, what the build measures, and what would change it.`,
        `5. Resolve with ${toolName('resolve_mark')} only the marks the build now meets, each with a short note of what you measured or saw. Leave the others open.`,
        ``,
        `End with a list: each mark and dimension by its id, met or not, and the number that shows it. Change no code unless asked.`
      ].join('\n')
  },
  printable: {
    description: 'Check the print layout for 3D printing: thin walls, overhangs, closed meshes and whether it fits the bed (argument bed, e.g. 256x256x256, in mm).',
    args: { bed: z.string().optional().describe('The printer bed in mm, as XxYxZ, e.g. 256x256x256.') },
    text: (toolName: ToolName, bed?: string): string => {
      const size = bed === undefined || bed.trim() === '' ? undefined : parseBed(bed)
      const bedStep =
        size !== undefined
          ? `4. Bed: call ${toolName('check')} with {"kind": "bed", "size": [${size.join(', ')}]} and say whether every part fits, and by how much it does not.`
          : bed !== undefined && bed.trim() !== ''
            ? `4. Bed: "${bed}" is not a bed size in mm such as 256x256x256. Ask the person for it, then call ${toolName('check')} with {"kind": "bed", "size": [x, y, z]}.`
            : `4. Bed: no bed size was given. Give the size of the print layout from ${toolName('scene')}, and ask the person for their bed (such as 256x256x256) before saying it fits.`
      return [
        `Check whether this project is ready to 3D print, on its print layout (layout "print"; if there is none, say so and use the layout it has).`,
        `If you have the skill torno:printing, read it first.`,
        ``,
        `1. Call ${toolName('scene')} for the parts of the layout and their sizes.`,
        `2. Walls: for each part call ${toolName('check')} with {"kind": "thin", "a": <part>, "min": 0.8} (or the least wall the person's nozzle can print); where that kind is not offered, ${toolName('measure')} the thickness of the thinnest-looking walls at a point of a face.`,
        `3. Overhangs: for each part call ${toolName('check')} with {"kind": "overhang", "a": <part>, "angle": 45}, and say where support would be needed. Closed meshes: call ${toolName('check')} with {"kind": "mesh", "a": <part>} for each part; an open mesh will not slice.`,
        bedStep,
        `5. ${toolName('look')} at the print layout to see how the parts sit on the bed.`,
        ``,
        `End with each part: printable or not, and why, with the numbers the tools gave. Change no code unless asked.`
      ].join('\n')
    }
  },
  explain: {
    description: 'Describe the model for someone new to it: its parts, its Params and how the parts relate.',
    text: (toolName: ToolName): string =>
      [
        `Explain this model to someone who has not seen it before.`,
        ``,
        `1. Call ${toolName('scene')}: its layouts, its parts with their sizes, and its params (the fields of the model's Params, with name, type and default).`,
        `2. Read the model's code for what each part is for and how the Params drive it.`,
        `3. ${toolName('look')} at it from a view or two that show how the parts go together; ${toolName('check')} with {"kind": "clearance"} where parts meet, if it helps.`,
        ``,
        `Say, in plain words: what the project is, each part and its role, each Param and what changing it does, and how the parts relate (what sits on, in or against what). Give sizes in mm as the tools give them. Change nothing.`
      ].join('\n')
  }
} as const

/** Registers the prompts on a server; their texts name tools as `toolName` does. */
export function registerPrompts(server: McpServer, toolName: ToolName = CLAUDE_TOOL): void {
  const message = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] })
  server.registerPrompt('review', { description: PROMPTS.review.description }, () => message(PROMPTS.review.text(toolName)))
  server.registerPrompt('printable', { description: PROMPTS.printable.description, argsSchema: PROMPTS.printable.args }, ({ bed }) => message(PROMPTS.printable.text(toolName, bed)))
  server.registerPrompt('explain', { description: PROMPTS.explain.description }, () => message(PROMPTS.explain.text(toolName)))
}
