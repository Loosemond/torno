import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pressed } from '../../../shared/keys'
import type { ChatImage } from '../../../shared/chat'
import { numbered } from '../numbered'

/** Only a picture's own kinds are put in an `img`. */
const SAFE_TYPE = /^image\/(png|jpeg|gif|webp)$/
const shows = (image: ChatImage): boolean => image.data !== undefined && image.data !== '' && SAFE_TYPE.test(image.mediaType)
const src = (image: ChatImage): string => `data:${image.mediaType};base64,${image.data}`

/**
 * The pictures of a message or of a tool's result, as thumbnails in a row; one is shown large over the pane when
 * it is clicked, until Escape or another click. A picture whose data is no longer kept says so.
 */
export function Pictures({ images, what }: { images: ChatImage[]; what: string }) {
  const [open, setOpen] = useState<number | null>(null)
  const back = useRef<HTMLButtonElement | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open !== null) layer.current?.focus()
  }, [open])
  if (images.length === 0) return null

  const close = (): void => {
    setOpen(null)
    // The focus goes back to the thumbnail it was taken from.
    requestAnimationFrame(() => back.current?.focus())
  }
  const shown = open === null ? undefined : images[open]
  // Over the transcript, not inside the group it is in: a group is contained (`content-visibility`), and would clip it.
  const host = shown ? root.current?.closest('.chat-scroll') : null

  return (
    <div className="chat-pictures" ref={root}>
      {images.map((image, n) =>
        shows(image) ? (
          <button
            key={image.id}
            type="button"
            className="chat-thumb"
            aria-label={`${what}: picture ${n + 1} of ${images.length}, larger`}
            onClick={(e) => {
              back.current = e.currentTarget
              setOpen(n)
            }}
          >
            <img src={src(image)} alt="" draggable={false} />
          </button>
        ) : (
          <span key={image.id} className="chat-thumb-gone">
            Picture not kept
          </span>
        )
      )}
      {shown && shows(shown) && host &&
        createPortal(
        <div
          ref={layer}
          className="chat-picture"
          role="dialog"
          aria-modal="true"
          aria-label={`${what}: picture ${open! + 1} of ${images.length}`}
          tabIndex={-1}
          onClick={close}
          onKeyDown={(e) => {
            // One thing to be on: Tab stays where it is.
            if (pressed(e, 'sheet.round')) e.preventDefault()
            if (!pressed(e, 'chat.close')) return
            e.stopPropagation()
            close()
          }}
        >
          <img src={src(shown)} alt="" />
          {shown.width && shown.height ? <p className="chat-picture-size">{numbered(`${shown.width} × ${shown.height} px`)}</p> : null}
        </div>,
        host
        )}
    </div>
  )
}
