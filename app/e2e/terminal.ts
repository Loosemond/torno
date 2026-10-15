import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Claude Code opens in a chat unless an object chooses its terminal. The specs that drive the terminal (typing into
 * it, reading what it shows) choose it in the temporary copy of the fixtures they work on, as a person would in
 * `.torno/agent.json`, and so keep testing the terminal and not the chat (`e2e/chat.spec.ts` tests that). With
 * no `objects`, every folder of the workspace that holds a model.
 */
export function inTerminal(root: string, objects?: string[]): void {
  const names = objects ?? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && readdirSync(join(root, e.name)).some((f) => f.endsWith('.py'))).map((e) => e.name)
  for (const name of names) {
    mkdirSync(join(root, name, '.torno'), { recursive: true })
    writeFileSync(join(root, name, '.torno', 'agent.json'), JSON.stringify({ agent: 'claude', view: 'terminal' }))
  }
}
