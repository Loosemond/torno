import { useEffect, useRef, useState } from 'react'
import { pressed } from '../../../shared/keys'
import type { ChatImage } from '../../../shared/chat'
import { numbered } from '../numbered'

const src = (image: ChatImage): string => `data:${image.mediaType};base64,${image.data}`

/**
 * The pictures of a message or of a tool's result, as thumbnails in a row; one is shown large over the pane when
 * it is clicked, until Escape or another click. A picture whose data is no longer kept says so.
 */
export function Pictures({ images, what }: { images: ChatImage[]; what: string }) {
  const [open, setOpen] = useState<number | null>(null)
  const back = useRef<HTMLButtonElement | null>(null)
  const layer = useRef<HTMLDivElement>(null)
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

  return (
    <div className="chat-pictures">
      {images.map((image, n) =>
        image.data ? (
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
      {shown?.data && (
        <div
          ref={layer}
          className="chat-picture"
          role="dialog"
          aria-modal="true"
          aria-label={`${what}: picture ${open! + 1} of ${images.length}`}
          tabIndex={-1}
          onClick={close}
          onKeyDown={(e) => {
            if (!pressed(e, 'chat.close')) return
            e.stopPropagation()
            close()
          }}
        >
          <img src={src(shown)} alt="" />
          {shown.width && shown.height ? <p className="chat-picture-size">{numbered(`${shown.width} × ${shown.height} px`)}</p> : null}
        </div>
      )}
    </div>
  )
}
