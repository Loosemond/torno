import { describe, expect, it } from 'vitest'
import { followTyped, hasEnter, lineShown, nothingNew, promptFile, sendLine } from './sendMarks'

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

it('says once that there is nothing new, for a file whose prompt has gone', () => {
  expect(nothingNew(new Date('2026-10-09T21:14:03Z'))).toBe('Nothing new from torno as of 2026-10-09 21:14:03 UTC: no line of its is waiting to be sent. The build and the open marks are in .torno/state.md.\n')
})

describe('followTyped: what became of a line at the cursor, from what was written to the terminal after it', () => {
  it('is sent by Enter, and by nothing typed before it', () => {
    expect(followTyped('\r')).toBe('sent')
    expect(followTyped('')).toBe('kept')
    // An answer to a question the CLI has up, or a word that opens a menu, and then Enter: not the line.
    expect(followTyped('y\r')).toBe('lost')
    expect(followTyped(' and make it 2 mm thicker\r')).toBe('lost')
    for (const typed of ['y', ' ', 'é', '日', '😀', '@']) expect(followTyped(typed), typed).toBe('lost')
  })

  it('is lost to a paste, whose line breaks are not an Enter', () => {
    // As xterm.js writes a paste of two lines while the agent has bracketed paste on: the break is a carriage return.
    expect(followTyped('\x1b[200~line one\rline two\x1b[201~')).toBe('lost')
    expect(followTyped('\x1b[200~lid/F4 tub/E2\x1b[201~')).toBe('lost')
    expect(followTyped('\x1b[200~lid/F4\x1b[201~\r')).toBe('lost')
    // One that does not end in the piece is no less a paste.
    expect(followTyped('\x1b[200~line one\rline')).toBe('lost')
  })

  it('is kept by what is not a key of the person\'s: the terminal\'s own answers, the focus and the pointer', () => {
    for (const reply of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[?2026;2$y', '\x1b[8;24;80t', '\x1b[?0u', '\x1b[<0;12;7M', '\x1b[<0;12;7m', '\x1b[<64;12;7M', '\x1b[M !!', '\x1b[M`\x7f\x21', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1bP1$r0m\x1b\\']) {
      expect(followTyped(reply), JSON.stringify(reply)).toBe('kept')
      expect(followTyped(`${reply}\r`), JSON.stringify(reply)).toBe('sent')
    }
    // The focus comes with the click into the terminal, the Enter after it.
    expect(followTyped('\x1b[O\x1b[I\r')).toBe('sent')
  })

  it('is kept by the keys that move along the line and change nothing: Left, Right, Home and End', () => {
    for (const key of ['\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1bOC', '\x1bOD', '\x1bOH', '\x1bOF', '\x1b[1~', '\x1b[4~', '\x1b[7~', '\x1b[8~', '\x1b[1;5C', '\x1b[1;2D', '\x1b[1;5H']) {
      expect(followTyped(key), JSON.stringify(key)).toBe('kept')
      expect(followTyped(`${key}\r`), JSON.stringify(key)).toBe('sent')
    }
  })

  it('is lost to anything that may have changed or cleared it, also when Enter follows', () => {
    // Backspace, ^U, ^W, ^C, ^K, ^D, ^A, tab, Delete, Up and Down (another prompt from history), PageUp, an Alt chord, a key torno does not know, a line feed.
    for (const key of ['\x7f', '\b', '\x15', '\x17', '\x03', '\x0b', '\x04', '\x01', '\t', '\x1b[3~', '\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', '\x1b[5~', '\x1b\x7f', '\x1bb', '\x1b[13u', '\x1b[1;5A', '\n']) {
      expect(followTyped(key), JSON.stringify(key)).toBe('lost')
      expect(followTyped(`${key}\r`), JSON.stringify(key)).toBe('lost')
    }
    // Esc by itself clears the input of many a CLI; with Enter it is the new line of Shift+Enter, which is typed into the line.
    expect(followTyped('\x1b')).toBe('lost')
    expect(followTyped('\x1b\r')).toBe('lost')
    expect(followTyped('\x1b\r\r')).toBe('lost')
    // What follows the Enter that sent it is of the next prompt.
    expect(followTyped('\r\x7f')).toBe('sent')
    // An answer cut short is not one torno can read.
    expect(followTyped('\x1b]11;rgb:1e1e')).toBe('lost')
    expect(followTyped('\x1b[12;40')).toBe('lost')
    expect(followTyped('\x1b[M !')).toBe('lost')
  })
})

describe('hasEnter: whether the person sent something', () => {
  it('is a carriage return that is not inside a paste, nor Esc\'s new line', () => {
    expect(hasEnter('\r')).toBe(true)
    expect(hasEnter('hello\r')).toBe(true)
    expect(hasEnter('hello')).toBe(false)
    expect(hasEnter('\x1b\r')).toBe(false)
    expect(hasEnter('\x1b[200~line one\rline two\x1b[201~')).toBe(false)
    expect(hasEnter('\x1b[200~line one\rline two\x1b[201~\r')).toBe(true)
    expect(hasEnter('\x1b[200~line one\rline')).toBe(false)
  })
})

describe('lineShown: whether the agent showed the line that was put at its cursor', () => {
  it('finds it in what the terminal was sent, whatever colours and moves are around it', () => {
    expect(lineShown('^[[200~torno: 1 new mark (M4) and the build status are in .torno/prompt.md. Read it first.^[[201~')).toBe(true)
    expect(lineShown('\x1b[2K\x1b[1G\x1b[38;5;244m> \x1b[0mtor\x1b[1mno\x1b[0m: 1 new mark')).toBe(true)
    expect(lineShown('\x1b]0;copilot\x07> torno: 1 new mark')).toBe(true)
  })

  it('does not find it in a question that is up instead of the prompt, nor in a name that only resembles it', () => {
    expect(lineShown('')).toBe(false)
    expect(lineShown('Do you trust the files in this folder?\r\n> 1. Yes\r\n  2. No')).toBe(false)
    expect(lineShown('\x1b]0;torno: a title\x07')).toBe(false)
    expect(lineShown('/home/me/torno/plain')).toBe(false)
  })
})
