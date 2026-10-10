import { describe, expect, it } from 'vitest'
import { followTyped, promptFile, sendLine } from './sendMarks'

it('says in one line what the file holds, with no character that could send it', () => {
  expect(sendLine(['M4', 'M5'])).toBe('torno: 2 new marks (M4, M5) and the build status are in .torno/prompt.md. Read it first.')
  expect(sendLine(['M4'])).toBe('torno: 1 new mark (M4) and the build status are in .torno/prompt.md. Read it first.')
  expect(sendLine([])).toBe('torno: the build status and the open marks are in .torno/prompt.md. Read it first.')
  expect(sendLine(Array.from({ length: 30 }, (_, i) => `M${i + 1}`))).toBe('torno: 30 new marks (M1, M2, M3, M4, M5, M6, M7, M8 and 22 more) and the build status are in .torno/prompt.md. Read it first.')
  expect(sendLine(['M4'])).not.toMatch(/[\r\n\u001b]/)
})

it('writes the context under the time it was written', () => {
  expect(promptFile('Build ok, r3.\nMarks from the user:', new Date('2026-10-09T21:14:03Z'))).toBe('Written 2026-10-09 21:14:03 UTC by torno, for the prompt that follows it.\n\nBuild ok, r3.\nMarks from the user:\n')
})

describe('followTyped: what became of a line at the cursor, from what was written to the terminal after it', () => {
  it('is sent by Enter, alone or after what was typed behind it', () => {
    expect(followTyped('\r')).toBe('sent')
    expect(followTyped(' and make it 2 mm thicker\r')).toBe('sent')
    expect(followTyped('é ü 日本 😀')).toBe('kept')
    expect(followTyped('')).toBe('kept')
    // A paste of the person's own goes in beside it.
    expect(followTyped('\x1b[200~lid/F4 tub/E2\x1b[201~')).toBe('kept')
    expect(followTyped('\x1b[200~lid/F4\x1b[201~\r')).toBe('sent')
  })

  it('is kept by what is not a key of the person\'s: the terminal\'s own answers, and the pointer', () => {
    for (const reply of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[?2026;2$y', '\x1b[8;24;80t', '\x1b[<0;12;7M', '\x1b[<0;12;7m', '\x1b[<64;12;7M', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1bP1$r0m\x1b\\']) {
      expect(followTyped(reply), JSON.stringify(reply)).toBe('kept')
      expect(followTyped(`${reply}\r`), JSON.stringify(reply)).toBe('sent')
    }
  })

  it('is kept by a new line in the prompt, which sends nothing', () => {
    expect(followTyped('\x1b\r')).toBe('kept')
    expect(followTyped('\x1b\rmore')).toBe('kept')
    expect(followTyped('\x1b\rmore\r')).toBe('sent')
  })

  it('is lost to anything that may have changed or cleared it, also when Enter follows', () => {
    // Backspace, ^U, ^W, ^C, ^K, ^D, ^A, tab, Delete, Up and Down (another prompt from history), Left, Home, an Alt chord, a key torno does not know.
    for (const key of ['\x7f', '\b', '\x15', '\x17', '\x03', '\x0b', '\x04', '\x01', '\t', '\x1b[3~', '\x1b[A', '\x1b[B', '\x1bOA', '\x1b[D', '\x1b[H', '\x1b\x7f', '\x1bb', '\x1b[13u', '\x1b[1;5C', '\n']) {
      expect(followTyped(key), JSON.stringify(key)).toBe('lost')
      expect(followTyped(`${key}\r`), JSON.stringify(key)).toBe('lost')
      expect(followTyped(`x${key}`), JSON.stringify(key)).toBe('lost')
    }
    // Esc by itself clears the input of many a CLI. (With Enter in the same piece it is the new line of Shift+Enter.)
    expect(followTyped('\x1b')).toBe('lost')
    expect(followTyped('x\x1b')).toBe('lost')
    // What follows the Enter that sent it is of the next prompt.
    expect(followTyped('\r\x7f')).toBe('sent')
    // An answer cut short is not one torno can read.
    expect(followTyped('\x1b]11;rgb:1e1e')).toBe('lost')
    expect(followTyped('\x1b[12;40')).toBe('lost')
  })
})
