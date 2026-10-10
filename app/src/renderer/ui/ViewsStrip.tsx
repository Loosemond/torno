import { useEffect, useRef, useState } from 'react'
import { type SavedView, MAX_VIEW_NAME, findView, goneText, holdsText, viewGone, viewNameRefusal } from '../../shared/views'
import { viewMatches } from '../state/savedViews'
import { actions, store, useStore } from '../state/store'
import type { Viewport } from '../viewport/Viewport'
import { numbered } from './numbered'

/** What is open under the strip: the field a name is typed in (for a new view, or for one that gets another name), or the actions of a view. */
type Open = { kind: 'save' } | { kind: 'rename'; view: string } | { kind: 'menu'; view: string; deleting: boolean } | null

/**
 * The saved views of the open object, in a strip under the view bar: a chip each, to put that view on screen, and
 * at the end "Save view", which keeps what is on screen under a name. A view the agent proposed says so and
 * waits to be kept or discarded; a view of a layout the model no longer has stays and cannot be applied; parts
 * and scans a view names that are gone are passed over, and the chip says how many.
 *
 * Applying a view changes how the object is looked at and nothing else: no geometry, no mark, no measurement.
 */
export function ViewsStrip({ viewport }: { viewport: Viewport }) {
  const views = useStore((s) => s.views)
  const scene = useStore((s) => s.scene)
  const scans = useStore((s) => (s.scansKnown ? s.scans : null))
  // The view that is on: the one last put on screen or saved from it, while the screen still shows what it holds.
  const active = useStore((s) => {
    const view = s.activeView === null ? undefined : findView(s.views, s.activeView)
    return view && viewMatches(s, view) ? view.name : null
  })
  const [open, setOpen] = useState<Open>(null)
  const strip = useRef<HTMLDivElement>(null)

  // A press anywhere else, or Escape, puts away what is open.
  useEffect(() => {
    if (open === null) return
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target instanceof Element && e.target.closest('.view-popover, [aria-haspopup]') && strip.current?.contains(e.target))) setOpen(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  // A view that is gone (removed, renamed, another object) has nothing open.
  const named = open !== null && open.kind !== 'save' ? open.view : null
  useEffect(() => {
    if (named !== null && !findView(views, named)) setOpen(null)
  }, [views, named])

  if (!scene) return null

  const apply = (view: SavedView): void => {
    const applied = actions.applyView(view.name)
    // The camera goes there once the store has the rest: the viewport follows the store as it is set.
    if (typeof applied === 'object') viewport.setView(applied.camera, true)
  }

  return (
    <div className="viewstrip" role="toolbar" aria-label="Saved views" ref={strip}>
      {views.map((view) => {
        const gone = viewGone(view, { layouts: scene.layouts, parts: scene.parts.filter((part) => part.layout === view.layout).map((part) => part.name), ...(scans ? { scans: scans.map((scan) => scan.id) } : {}) })
        const quiet = goneText(gone)
        const lost = [...gone.parts, ...gone.scans]
        const title = gone.layout
          ? `Layout ${view.layout} is no longer in the model`
          : [holdsText(view), view.note, lost.length > 0 ? `${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} no longer there: passed over` : ''].filter(Boolean).join(' · ')
        const menu = open?.kind === 'menu' && open.view === view.name ? open : null
        return (
          <div key={view.name} className="view-item" data-proposed={view.proposed ? '' : undefined} data-active={active === view.name ? '' : undefined}>
            <button
              type="button"
              className="view-chip"
              data-view={view.name}
              aria-pressed={active === view.name}
              aria-disabled={gone.layout ? true : undefined}
              title={title}
              onClick={() => {
                if (!gone.layout) apply(view)
              }}
            >
              <span className="view-name">{numbered(view.name)}</span>
              {view.proposed && <span className="view-note">proposed</span>}
              {quiet !== '' && <span className="view-note view-gone">{numbered(quiet)}</span>}
            </button>
            {view.proposed ? (
              <>
                <button type="button" className="view-act" aria-label={`Keep ${view.name}`} title="Keep this view the agent proposed" onClick={() => actions.keepView(view.name)}>
                  Keep
                </button>
                <button type="button" className="view-act" aria-label={`Discard ${view.name}`} title="Discard this view the agent proposed" onClick={() => actions.removeView(view.name)}>
                  Discard
                </button>
              </>
            ) : (
              <button
                type="button"
                className="view-act view-more"
                aria-label={`Actions for ${view.name}`}
                title="Rename, update or delete"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                onClick={() => setOpen(menu ? null : { kind: 'menu', view: view.name, deleting: false })}
              >
                <DotsIcon />
              </button>
            )}
            {menu && !menu.deleting && (
              <div className="menu view-popover" role="menu" aria-label={`Actions for ${view.name}`}>
                <button type="button" role="menuitem" className="menu-item" onClick={() => setOpen({ kind: 'rename', view: view.name })}>
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  title="Keep what is on screen now under this name"
                  onClick={() => {
                    actions.saveView(view.name, viewport.getCamera())
                    setOpen(null)
                  }}
                >
                  Update to what is on screen
                </button>
                <button type="button" role="menuitem" className="menu-item" onClick={() => setOpen({ ...menu, deleting: true })}>
                  Delete
                </button>
              </div>
            )}
            {menu?.deleting && (
              <div className="menu view-popover view-confirm" role="alertdialog" aria-label={`Delete the view ${view.name}?`}>
                <p>Delete {numbered(`"${view.name}"`)}?</p>
                <div className="view-confirm-buttons">
                  <button type="button" className="button view-delete" onClick={() => actions.removeView(view.name)}>
                    Delete
                  </button>
                  {/* Where the focus goes: Enter leaves the view as it is. */}
                  <button type="button" className="button" autoFocus onClick={() => setOpen(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {open?.kind === 'rename' && open.view === view.name && (
              <NameField key={`rename ${view.name}`} label="Rename" first={view.name} refusal={(name) => viewNameRefusal(name, store.getState().views, 'user', view.name)} keep={(name) => actions.renameView(view.name, name)} done={() => setOpen(null)} />
            )}
          </div>
        )
      })}
      <div className="view-item view-item-add">
        <button type="button" className="view-chip view-add" aria-haspopup="dialog" aria-expanded={open?.kind === 'save'} title="Keep what is on screen under a name: camera, layout, parts, section or explode, scans" onClick={() => setOpen(open?.kind === 'save' ? null : { kind: 'save' })}>
          + Save view
        </button>
        {open?.kind === 'save' && (
          <NameField label={(name) => (findView(views, name) ? 'Replace' : 'Save')} first="" refusal={(name) => viewNameRefusal(name, store.getState().views, 'user')} keep={(name) => actions.saveView(name, viewport.getCamera())} done={() => setOpen(null)} />
        )}
      </div>
    </div>
  )
}

/**
 * One field for the name of a view, under what opened it: Enter keeps, Escape puts it away, and a name that will
 * not do is said under the field, where it was typed.
 */
function NameField({ label, first, refusal, keep, done }: { label: string | ((name: string) => string); first: string; refusal: (name: string) => string | null; keep: (name: string) => string | null; done: () => void }) {
  const [name, setName] = useState(first)
  const [refused, setRefused] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus({ preventScroll: true })
    field.current?.select()
  }, [])

  const submit = (): void => {
    const why = refusal(name) ?? keep(name)
    if (why === null) done()
    else setRefused(why)
  }

  return (
    <form
      className="menu view-popover view-name-card"
      role="dialog"
      aria-label={typeof label === 'string' ? `${label} the view` : 'Save the view on screen'}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="view-name-row">
        <input
          ref={field}
          className="view-name-field"
          type="text"
          aria-label="Name of the view"
          aria-invalid={refused !== null}
          placeholder="Name of the view"
          maxLength={MAX_VIEW_NAME}
          spellCheck={false}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setRefused(null)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            done()
          }}
        />
        <button type="submit" className="button">
          {typeof label === 'string' ? label : label(name)}
        </button>
      </div>
      {refused !== null && (
        <p className="view-refusal" role="alert">
          {numbered(refused)}
        </p>
      )}
    </form>
  )
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  )
}
