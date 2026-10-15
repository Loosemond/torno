import { refsIn } from '../../../shared/chat'
import { RefChip } from './RefChip'

/** Text as it is, but for its refs, which are chips. For the monospace text of a tool's input and result. */
export function RefText({ text }: { text: string }) {
  return (
    <>
      {refsIn(text).map((piece, n) => (piece.ref !== undefined ? <RefChip key={n} value={piece.ref} /> : piece.text))}
    </>
  )
}
