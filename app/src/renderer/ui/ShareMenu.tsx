import { useEffect, useRef, useState } from 'react'
import { pressed } from '../../shared/keys'
import { PICTURE_SIZES, type ExportSaved } from '../../shared/exportdata'
import { pictureForPerson } from '../state/agent'
import { store, useStore } from '../state/store'

/** The name of a file in a path of either kind, for the line that says where a file went. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/**
 * "Share" in the status line, beside "Export…": keeps what the view shows as a file. A picture of it (PNG; the long edge up to 4000 px: a
 * picture for a person is not held to the 2000 px of the agent's; the marks and the axes and scale bar are chosen here;
 * the window draws it with the renderer `look` uses), and, while a section is on screen, a drawing of the cut at true
 * scale (SVG, made in main from the kernel's outlines). Main asks where to save either: the window never names a path.
 */
export function ShareMenu() {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState(PICTURE_SIZES[0])
  const [marks, setMarks] = useState(true)
  const [cues, setCues] = useState(true)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null)
  const cut = useStore((s) => s.section !== null)
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

  /** Makes a file of the view and has main save it; what is said is where it went, or why it did not. */
  async function keep(make: (objectId: string) => Promise<ExportSaved | null>) {
    const objectId = store.getState().objectId
    if (objectId === null || busy) return
    setBusy(true)
    setSaid(null)
    try {
      const saved = await make(objectId)
      if (saved) setSaid({ text: `Saved ${baseName(saved.path)}`, failed: false })
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : String(e), failed: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="share-menu" ref={root}>
      <button type="button" className="status-export" aria-haspopup="menu" aria-expanded={open} title="Save a picture of the view, or a drawing of its section" onClick={() => setOpen((was) => !was)}>
        Share
      </button>
      {open && (
        <div className="menu picture-menu" role="menu" aria-label="Share the view">
          <p className="menu-title">Picture, long edge in pixels</p>
          {PICTURE_SIZES.map((one) => (
            <button key={one} type="button" role="menuitemradio" aria-checked={size === one} className="menu-item picture-choice" data-size={one} onClick={() => setSize(one)}>
              <span className="num">{one}</span>
            </button>
          ))}
          <button type="button" role="menuitemcheckbox" aria-checked={marks} className="menu-item picture-choice" data-option="marks" onClick={() => setMarks((was) => !was)}>
            Marks
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={cues} className="menu-item picture-choice" data-option="cues" onClick={() => setCues((was) => !was)}>
            Axes and scale bar
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-action="save-picture"
            disabled={busy}
            onClick={() =>
              void keep(async (objectId) => {
                const picture = await pictureForPerson(size, marks, cues)
                return window.torno.export.savePicture(objectId, picture.png)
              })
            }
          >
            {busy ? 'Working…' : 'Save picture…'}
          </button>
          <hr className="menu-rule" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-action="save-section"
            disabled={busy || !cut}
            title={cut ? 'The outlines of the cut at true scale, in millimetres, with a scale bar and a title block: an SVG' : 'Cut the project first (the Section tool)'}
            onClick={() => void keep((objectId) => window.torno.export.saveSection(objectId))}
          >
            Save section drawing…
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
