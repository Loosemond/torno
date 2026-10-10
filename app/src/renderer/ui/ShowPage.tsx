import { useEffect, useRef, useState } from 'react'
import type { ObjectCard } from '../../shared/show'
import { actions, store, useStore } from '../state/store'
import { buildLine, cardChips, matching, pictureLine, stepCard } from './cards'
import { numbered } from './numbered'
import { TYPING } from './typing'
import { DatumMark } from './ViewportPane'

/** The key that brings the page of objects up from an object's view. On the page, Escape goes back. */
export const PAGE_KEY = 'W'

/**
 * `W` outside any field shows the page of objects over the object that is open. The way back is the page's own
 * (Escape, or a card): on the page a letter is typed into its filter.
 */
export function usePageKey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key.toUpperCase() !== PAGE_KEY) return
      if (e.target instanceof Element && e.target.closest(TYPING)) return
      if (store.getState().page !== 'object') return
      actions.showPage('objects')
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** How many cards stand in the first row of the grid, as it is laid out now. */
function columnsOf(cards: HTMLElement[]): number {
  if (cards.length === 0) return 1
  const top = cards[0].offsetTop
  const n = cards.findIndex((card) => card.offsetTop !== top)
  return n < 0 ? cards.length : n
}

/**
 * The page of objects: a card for each object of the workspace, with the picture it has on file, how its build
 * stands and what is open on it. It lies over the 3D view, which stays as it is underneath. Looking at it costs
 * what reading a few small files costs: nothing is built, started or loaded for a card, and a picture is asked
 * for only once its card comes into view.
 *
 * By the keys: the arrows go from card to card, Enter opens the one in focus, `/` or any letter filters by name,
 * Escape empties the filter and then goes back to the object that was open.
 */
export function ShowPage({ onOpen }: { onOpen: (id: string) => void }) {
  const workspace = useStore((s) => s.workspace)
  const openId = useStore((s) => s.objectId)
  const [cards, setCards] = useState<ObjectCard[] | null>(null)
  const [typed, setTyped] = useState('')
  const page = useRef<HTMLElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const filter = useRef(typed)
  filter.current = typed
  const root = workspace?.root

  // The cards, asked for again whenever main says one may say something else.
  useEffect(() => {
    let live = true
    let asked = 0
    const ask = (): void => {
      const mine = ++asked
      window.torno.show.cards().then(
        (found) => {
          if (live && mine === asked) setCards(found)
        },
        () => {}
      )
    }
    ask()
    const off = window.torno.show.onChanged(ask)
    return () => {
      live = false
      off()
    }
  }, [root])

  // The keys are the page's while it is up: the card of the open object has the focus, or the first.
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current || !cards || cards.length === 0) return
    focused.current = true
    const active = document.activeElement
    if (active instanceof Element && active.closest(TYPING)) return // someone is typing somewhere else
    const found = [...page.current!.querySelectorAll<HTMLElement>('.card')]
    ;(found.find((card) => card.dataset.object === store.getState().objectId) ?? found[0])?.focus()
  }, [cards])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      const here = target !== null && page.current!.contains(target)
      // Somewhere else to type: the session's terminal, a field of the left column.
      if (!here && target?.closest(TYPING)) return
      // Whatever else is pressed is the page's: no tool of the view under it is handed a key.
      e.stopPropagation()
      if (e.key === 'Tab') return
      const found = [...page.current!.querySelectorAll<HTMLElement>('.card')]
      if (e.key === 'Escape') {
        e.preventDefault()
        if (filter.current !== '') {
          setTyped('')
          if (target === field.current) (found[0] ?? field.current)?.focus()
        } else actions.showPage('object')
        return
      }
      if (target === field.current) {
        // In the field the keys are the field's, but for the two that leave it: down to the cards, Enter for the first of them.
        if (e.key !== 'ArrowDown' && e.key !== 'Enter') return
        e.preventDefault()
        if (e.key === 'Enter') found[0]?.click()
        else found[0]?.focus()
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        field.current?.focus()
        field.current?.select()
        return
      }
      const to = stepCard(e.key, found.indexOf(document.activeElement as HTMLElement), found.length, columnsOf(found))
      if (to !== null) {
        e.preventDefault()
        const next = to === 'field' ? field.current : found[to]
        next?.focus()
        next?.scrollIntoView({ block: 'nearest' })
        return
      }
      // A letter or a figure starts a name: it goes into the field, which takes it from here. Enter and the space bar are the button's in focus.
      if (e.key.length === 1 && e.key !== ' ') field.current?.focus()
    }
    // Before anything else hears of the key: the tools' own listeners are on the window too.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const shown = cards ? matching(cards, typed) : []
  const name = root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root : ''

  return (
    <section ref={page} className="show" aria-label={`Objects of ${name}`}>
      <header className="show-head">
        <div className="show-title">
          <h2>Objects</h2>
          {cards && cards.length > 0 && (
            <p className="show-count">
              {typed.trim() !== '' && (
                <>
                  <span className="num">{shown.length}</span> of{' '}
                </>
              )}
              <span className="num">{cards.length}</span> in {name}
            </p>
          )}
        </div>
        {cards && cards.length > 0 && (
          <label className="show-filter">
            <input ref={field} type="text" value={typed} placeholder="Filter by name" aria-label="Filter the objects by name" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
            <kbd aria-hidden="true">/</kbd>
          </label>
        )}
      </header>
      {cards && cards.length === 0 && (
        <div className="show-empty">
          <DatumMark />
          <h3>No objects here yet</h3>
          <p>An object is a folder in this one with a build123d model in it: a Python file that builds its parts. Make one, or ask the agent for one, and its card appears here.</p>
        </div>
      )}
      {cards && cards.length > 0 && shown.length === 0 && (
        <p className="show-none">
          No object is named like <span className="show-typed">{typed.trim()}</span>. Escape shows them all.
        </p>
      )}
      {shown.length > 0 && (
        <div className="cards">
          {shown.map((card) => (
            <Card key={card.id} card={card} open={card.id === openId} onOpen={onOpen} />
          ))}
        </div>
      )}
      {cards && cards.length > 0 && (
        <p className="show-keys">
          <kbd>Arrows</kbd> move · <kbd>Enter</kbd> opens · <kbd>/</kbd> or a letter filters
          {openId !== null && (
            <>
              {' '}
              · <kbd>Esc</kbd> back to {openId}
            </>
          )}
        </p>
      )}
    </section>
  )
}

function Card({ card, open, onOpen }: { card: ObjectCard; open: boolean; onOpen: (id: string) => void }) {
  const build = buildLine(card)
  const picture = pictureLine(card)
  const chips = cardChips(card)
  // The status wins over the picture: one of a build that is no longer what the model makes is dimmed.
  const failed = card.opened && card.build?.status === 'failed'
  return (
    <button type="button" className="card" data-object={card.id} aria-current={open ? 'true' : undefined} data-problem={card.problem !== undefined ? '' : undefined} onClick={() => onOpen(card.id)}>
      <Picture card={card} dimmed={failed} />
      <span className="card-body">
        <span className="card-head">
          <span className="card-name">{card.name}</span>
          {open && <span className="card-open">Open</span>}
        </span>
        <span className="card-line" data-part="build" data-tone={build.tone} title={build.text}>
          {numbered(build.text)}
        </span>
        {picture && (
          <span className="card-line" data-part="picture">
            {numbered(picture.text)}
          </span>
        )}
        {picture?.behind && (
          <span className="card-line" data-part="behind" data-tone="warn">
            The model has changed since
          </span>
        )}
        {chips.length > 0 && (
          <span className="card-chips">
            {chips.map((chip) => (
              <span key={chip.text} className="card-chip" data-tone={chip.tone}>
                {numbered(chip.text)}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  )
}

/** How far outside the part of the page in view a card's picture is already asked for. */
const NEAR = '240px'

/**
 * The picture a card has on file, on the ground of the 3D view. It is asked of main only once the card is in
 * view or near it, and again when another was made; a card with none says so, and what makes one.
 */
function Picture({ card, dimmed }: { card: ObjectCard; dimmed: boolean }) {
  const holder = useRef<HTMLSpanElement>(null)
  const [near, setNear] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const at = card.thumb?.at

  useEffect(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setNear(true)
        seen.disconnect()
      },
      { root: holder.current!.closest('.show'), rootMargin: NEAR }
    )
    seen.observe(holder.current!)
    return () => seen.disconnect()
  }, [])

  useEffect(() => {
    if (!near || at === undefined) {
      setUrl(null)
      return
    }
    let live = true
    let made: string | null = null
    window.torno.show.thumbnail(card.id).then(
      (png) => {
        if (!live) return
        made = png ? URL.createObjectURL(new Blob([png], { type: 'image/png' })) : null
        setUrl(made)
      },
      () => live && setUrl(null)
    )
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [near, at, card.id])

  return (
    <span ref={holder} className="card-picture" data-dimmed={dimmed && url ? '' : undefined}>
      {url ? (
        <img src={url} alt="" width={480} height={360} draggable={false} />
      ) : at === undefined ? (
        <span className="card-nopicture">
          <DatumMark />
          <span>No picture yet</span>
          {card.problem === undefined && <span className="card-nopicture-how">{card.opened ? 'One is made when it builds' : 'Open it, and one is made from its build'}</span>}
        </span>
      ) : null}
    </span>
  )
}
