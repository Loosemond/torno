import type { ReactNode } from 'react'

/**
 * What is set in the face of numbers in a sentence: a number; and what names a scan or a mark (`S1`, `M4`), a
 * build (`r12`), or a part's face or edge (`tub/F25`), whole. A ref is one thing: half of it in another face
 * reads as two.
 */
const SET = /(\b[SM]\d+\b|\br\d+\b|(?<![\w.-])[\w.-]+\/(?:[FE]\d+|@[A-Za-z_]\w*(?:[.-]\w+)*)\b|-?\d[\d.,]*\d|-?\d)/

/** A sentence in pieces: every second one, from the second, is a number or a ref. (`['', 'S1', ' is aligned by ', '4', ' pairs']`.) */
export function numberedPieces(text: string): string[] {
  return text.split(SET)
}

/** A sentence with every number and every ref of it in the monospace face. */
export function numbered(text: string): ReactNode[] {
  return numberedPieces(text).map((piece, n) =>
    n % 2 === 1 ? (
      <span key={n} className="num">
        {piece}
      </span>
    ) : (
      piece
    )
  )
}

/** A sentence as one starts: with a capital. */
export const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
