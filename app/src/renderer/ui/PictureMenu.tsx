import { useEffect, useRef, useState } from 'react'
import { pressed } from '../../shared/keys'
import { PICTURE_SIZES } from '../../shared/exportdata'
import { pictureForPerson } from '../state/agent'
import { store } from '../state/store'

/** The name of a file in a path of either kind, for the line that says where a picture went. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/**
 * "Picture" in the view bar: keeps a picture of the view as it is, for a forum, a chat or a document. The size
 * (its long edge, up to 4000 px: a picture for a person is not held to the 2000 px of the agent's), the marks and the
 * axes and scale bar are chosen here; the window draws it with the renderer `look` uses, and main asks where to save
 * it. The window never names a path.
 */
export function PictureMenu() {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState(PICTURE_SIZES[0])
  const [marks, setMarks] = useState(true)
  const [cues, setCues] = useState(true)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? pressed(e, 'menu.close') : !root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  async function save() {
    const objectId = store.getState().objectId
    if (objectId === null || busy) return
    setBusy(true)
    setSaid(null)
    try {
      const picture = await pictureForPerson(size, marks, cues)
      const saved = await window.torno.export.savePicture(objectId, picture.png)
      if (saved) setSaid({ text: `Saved ${baseName(saved.path)}`, failed: false })
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : String(e), failed: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="viewbar-more" ref={root}>
      <button type="button" className="bar-button" aria-haspopup="menu" aria-expanded={open} title="Save a picture of the view" onClick={() => setOpen((was) => !was)}>
        Picture
      </button>
      {open && (
        <div className="menu picture-menu" role="menu" aria-label="Save a picture of the view">
          <p className="menu-title">Long edge, pixels</p>
          {PICTURE_SIZES.map((one) => (
            <button key={one} type="button" role="menuitemradio" aria-checked={size === one} className="menu-item picture-choice" data-size={one} onClick={() => setSize(one)}>
              <span className="num">{one}</span>
            </button>
          ))}
          <hr className="menu-rule" />
          <button type="button" role="menuitemcheckbox" aria-checked={marks} className="menu-item picture-choice" data-option="marks" onClick={() => setMarks((was) => !was)}>
            Marks
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={cues} className="menu-item picture-choice" data-option="cues" onClick={() => setCues((was) => !was)}>
            Axes and scale bar
          </button>
          <hr className="menu-rule" />
          <button type="button" role="menuitem" className="menu-item" data-action="save-picture" disabled={busy} onClick={() => void save()}>
            {busy ? 'Drawing…' : 'Save picture…'}
          </button>
          {said && (
            <p className="menu-title" role="status" data-failed={said.failed ? '' : undefined}>
              {said.text}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
