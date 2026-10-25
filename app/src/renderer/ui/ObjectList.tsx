import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { pressed, which } from '../../shared/keys'
import type { ObjectInfo } from '../../shared/workspace'
import { switcherShown } from '../state/column'
import { actions, useStore } from '../state/store'
import { openNewObject } from './onboard/NewObject'
import { PAGE_KEY } from './ShowPage'
import { SectionTitle } from './SectionTitle'
import { SessionDot } from './SessionDot'
import { rowSaid, signOf, switcherSign } from './sessionSign'

/**
 * The objects of the workspace. One that cannot be built is muted, with the reason as its tooltip. While an object is
 * open (or a new one is being made) in a workspace of several, the list folds to a switcher (`ObjectSwitcher`), and
 * its title unfolds it in place; with no object open, or the page of objects up, the list is whole.
 */
export function ObjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const objects = useStore((s) => s.workspace?.objects ?? NONE)
  const openId = useStore((s) => s.objectId)
  const paged = useStore((s) => s.page === 'objects')
  const creating = useStore((s) => s.page === 'new')
  const sessions = useStore((s) => s.sessions)
  const switcher = useStore((s) => switcherShown({ folded: s.column.folded.objects, objects: s.workspace?.objects ?? NONE, objectId: s.objectId, page: s.page }))
  // The column is of an object (one open, or a new one being made, in a workspace of several): the title folds the
  // list, but not while the page of objects is up, and the way to the page is beside it, the one control it is
  // whatever the list shows, so that the focus it had comes back to it when the page goes.
  const ofObject = objects.length > 1 && (creating || openId !== null)

  return (
    <nav className="section objects" aria-label="Projects" data-switcher={switcher ? '' : undefined}>
      {ofObject ? (
        <SectionTitle section="objects" title="Projects" said={`${objects.length}`} still={paged}>
          {/* The page of the workspace's objects, over the view; pressed again, back to the object that is open. */}
          <button type="button" className="button button-quiet page-button" aria-pressed={paged} title={`All projects (${PAGE_KEY})`} onClick={() => actions.showPage(paged ? 'object' : 'objects')}>
            <PageIcon />
            All projects
            <kbd aria-hidden="true">{PAGE_KEY}</kbd>
          </button>
        </SectionTitle>
      ) : (
        <h2 className="section-title">Projects</h2>
      )}
      {switcher ? (
        <ObjectSwitcher objects={objects} onOpen={onOpen} />
      ) : objects.length === 0 ? (
        // The page of objects says it in full beside this: it is said once.
        !paged && <p className="section-note">No projects here yet. A project is a folder with a Python model in it.</p>
      ) : (
        <ul className="rows">
          {!ofObject && (
            <li>
              {/* The page of the workspace's objects, over the view. */}
              <button type="button" className="row page-row" aria-pressed={paged} title={`All projects (${PAGE_KEY})`} onClick={() => actions.showPage(paged ? 'object' : 'objects')}>
                <PageIcon />
                <span className="row-name">All projects</span>
                <kbd aria-hidden="true">{PAGE_KEY}</kbd>
              </button>
            </li>
          )}
          {objects.map((o) => {
            // The session of an object that is not the one open still asks for the person, or works: said where the eye is.
            const sign = signOf(sessions[o.id]?.status)
            const said = rowSaid(sign)
            return (
              <li key={o.id}>
                <button
                  type="button"
                  className="row object-row"
                  aria-current={o.id === openId && !creating ? 'true' : undefined}
                  aria-description={said}
                  data-problem={o.problem ? '' : undefined}
                  data-session={sign ?? undefined}
                  title={o.problem ?? (said && `${o.name}, ${said}`)}
                  onClick={() => onOpen(o.id)}
                >
                  <span className="row-name">{o.name}</span>
                  {sign !== null && <SessionDot sign={sign} word />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {/* The way to a new object: a page for what it is and what there is to give, then Claude Code starts with it. In the switcher, at the foot of its menu. */}
      {!switcher && (
        <button type="button" className="button button-quiet new-object-button" aria-pressed={creating} onClick={openNewObject}>
          <PlusIcon />
          New project
        </button>
      )}
    </nav>
  )
}

/**
 * The list folded to one row: the name of the open object in ink ("New object", pressed, while a new one is being
 * made), with the sign of any session of the list that works or waits (`switcherSign`). Its name is the object's, as
 * a row's is, and what the sessions do is its description. A click or Enter opens a menu of every object, as the
 * rows of the list, a muted one with its reason as a second line, and "New object" at its foot. Arrows, Home and End
 * move in it (the keys of `FolderMenu`); Escape and Tab put it away. Chosen with the pointer, the keys go back to the
 * view; with the keys, to the switcher.
 */
function ObjectSwitcher({ objects, onOpen }: { objects: readonly ObjectInfo[]; onOpen: (id: string) => void }) {
  const openId = useStore((s) => s.objectId)
  const creating = useStore((s) => s.page === 'new')
  const sessions = useStore((s) => s.sessions)
  const [shown, setShown] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = (): HTMLElement[] => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  const current = creating ? undefined : objects.find((o) => o.id === openId)
  const name = creating ? 'New project' : (current?.name ?? openId ?? '')
  const { sign, said, word } = switcherSign(creating ? null : openId, objects, sessions)

  useEffect(() => {
    if (!shown) return
    const away = (e: PointerEvent): void => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setShown(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [shown])

  // Into the menu once it is there: on the open object, or the first.
  useEffect(() => {
    if (!shown) return
    const all = items()
    ;(all.find((item) => item.getAttribute('aria-current') === 'true') ?? all[0])?.focus({ preventScroll: true })
    all.find((item) => item === document.activeElement)?.scrollIntoView({ block: 'nearest' })
  }, [shown])

  const close = (): void => {
    setShown(false)
    button.current?.focus()
  }
  /** A choice made: with the keys (no count of clicks), the focus stays on the switcher; with the pointer, the next letter is the view's. */
  const choose = (detail: number, then: () => void): void => {
    setShown(false)
    if (detail === 0) button.current?.focus()
    then()
  }
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLElement)
    const end = which(e, 'menu.ends')
    if (pressed(e, 'menu.close')) close()
    else if (pressed(e, 'menu.next')) all[(at + 1) % all.length]?.focus()
    else if (pressed(e, 'menu.previous')) all[(at - 1 + all.length) % all.length]?.focus()
    else if (end === 0) all[0]?.focus()
    else if (end === 1) all.at(-1)?.focus()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="object-switcher-host">
      <button
        ref={button}
        type="button"
        className="row object-switcher"
        data-object={current?.id}
        data-problem={current?.problem ? '' : undefined}
        data-session={sign ?? undefined}
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-pressed={creating ? true : undefined}
        aria-description={said}
        title={[current?.problem, said && `${name}, ${said}`].filter(Boolean).join('. ') || 'Open another project'}
        onClick={() => setShown((was) => !was)}
      >
        <span className="row-name">{name}</span>
        {sign !== null && <SessionDot sign={sign} word={word ?? false} />}
        <svg className="object-switcher-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 6.25 8 9.75l3.5-3.5" />
        </svg>
      </button>
      {shown && (
        <div ref={menu} className="menu object-menu" role="menu" aria-label="Projects" onKeyDown={onKeyDown}>
          {objects.map((o) => {
            const itemSign = signOf(sessions[o.id]?.status)
            const itemSaid = rowSaid(itemSign)
            return (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                className="menu-item object-item"
                aria-label={o.name}
                aria-current={o.id === openId && !creating ? 'true' : undefined}
                aria-description={[o.problem, itemSaid].filter(Boolean).join('; ') || undefined}
                data-problem={o.problem ? '' : undefined}
                data-session={itemSign ?? undefined}
                onClick={(e) => choose(e.detail, () => onOpen(o.id))}
              >
                <span className="object-item-name">
                  <span className="row-name">{o.name}</span>
                  {itemSign !== null && <SessionDot sign={itemSign} word />}
                </span>
                {o.problem && <span className="object-item-problem">{o.problem}</span>}
              </button>
            )
          })}
          <hr className="menu-rule" />
          <button type="button" role="menuitem" className="menu-item object-item-new" onClick={(e) => choose(e.detail, openNewObject)}>
            <PlusIcon />
            New project
          </button>
        </div>
      )}
    </div>
  )
}

function PageIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <rect x="2.25" y="2.75" width="4.75" height="4.25" rx="1" />
      <rect x="9" y="2.75" width="4.75" height="4.25" rx="1" />
      <rect x="2.25" y="9" width="4.75" height="4.25" rx="1" />
      <rect x="9" y="9" width="4.75" height="4.25" rx="1" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

const NONE: never[] = []
