import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KernelError, isBusy } from './client'

const SUPERVISOR = resolve(__dirname, '../../../../kernel/src/torno_kernel/supervisor.py')

describe('isBusy', () => {
  // The busy answer has the kind of a real timeout and is told apart by its words alone.
  it('knows the sentence the supervisor really writes', () => {
    const source = readFileSync(SUPERVISOR, 'utf8')
    const said = /f"the build of \{dir\} (is still busy with a query it did not answer) "/.exec(source)
    expect(said).not.toBeNull()
    expect(isBusy(new KernelError('timeout', `the build of /tmp/x ${said![1]} within 30 s; ask again when it has`))).toBe(true)
  })

  it('is not a query that took too long itself', () => {
    expect(isBusy(new KernelError('timeout', 'no answer within 30 s'))).toBe(false)
  })
})
