#!/usr/bin/env node
// `pnpm -C app eval`: the evals. Not built yet beyond the safeguard.
import { createInterface } from 'node:readline/promises'
import { guard } from './guard.mjs'

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const no = await guard(process.env, { agent: 'claude', model: 'sonnet', budgetUsd: 2, cases: [], repeats: 5 }, (q) => rl.question(q).catch(() => null))
  rl.close()
  if (no) {
    console.error(no)
    process.exit(2)
  }
}

await main()
