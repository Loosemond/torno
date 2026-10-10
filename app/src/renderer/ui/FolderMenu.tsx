import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { pressed, which } from '../../shared/keys'
import type { RecentFolder } from '../../shared/workspace'

/** A folder as its row names it: its own name. */
export function folderName(root: string): string {
  return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
}

/** What the menu asks to be opened: a folder by its path, the one still to be chosen in the dialog, or the example. */
export type FolderChoice = { root: string } | 'pick' | 'example'

/**
 * The folder button at the top of the left column, and its menu: the folders opened lately (the open one
 * marked; one that is not found struck, with a way to take it off the list), then the folder dialog, and the
 * example where torno has one. It is the way back to another workspace without the first screen. The list is
 * read when the menu opens, each time. Arrows, Home and End move among the items; Escape and Tab put it away.
 */
export function FolderMenu({ open: current, disabled, onChoose }: { open: string; disabled: boolean; onChoose: (choice: FolderChoice) => void }) {
  const [shown, setShown] = useState(false)
  const [recent, setRecent] = useState<RecentFolder[]>([])
  const [example, setExample] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = (): HTMLElement[] => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]

  useEffect(() => {
    if (!shown) return
    let live = true
    void window.torno.workspace.recent().then((list) => live && setRecent(list), () => {})
    void window.torno.workspace.hasExample().then((has) => live && setExample(has), () => {})
    const away = (e: PointerEvent): void => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setShown(false)
    }
    window.addEventListener('pointerdown', away)
    return () => {
      live = false
      window.removeEventListener('pointerdown', away)
    }
  }, [shown])

  // Into the menu once it is there: the first thing that can be chosen.
  useEffect(() => {
    if (shown) items()[0]?.focus({ preventScroll: true })
  }, [shown, recent.length])

  const close = (): void => {
    setShown(false)
    button.current?.focus()
  }
  const choose = (choice: FolderChoice): void => {
    setShown(false)
    onChoose(choice)
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
    <div className="folder-menu-host">
      <button ref={button} type="button" className="icon-button" aria-label="Folders" title="Open another folder" aria-haspopup="menu" aria-expanded={shown} disabled={disabled} onClick={() => setShown((was) => !was)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" aria-hidden="true">
          <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.6l1.5 1.75h5.4c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5v-7.5Z" />
        </svg>
      </button>
      {shown && (
        <div ref={menu} className="menu folder-menu" role="menu" aria-label="Folders" onKeyDown={onKeyDown}>
          {recent.length > 0 && (
            <>
              <p className="menu-title">Recent folders</p>
              {recent.map((folder) => (
                <div key={folder.root} className="folder-row" data-missing={folder.missing ? '' : undefined} data-open={folder.root === current ? '' : undefined}>
                  <button type="button" role="menuitem" className="menu-item folder-item" disabled={folder.missing || folder.root === current} title={folder.missing ? `${folder.root} was not found` : folder.root} onClick={() => choose({ root: folder.root })}>
                    <span className="folder-name">{folderName(folder.root)}</span>
                    <span className="folder-path num">
                      <bdi>{folder.root}</bdi>
                    </span>
                  </button>
                  {folder.root === current && <span className="folder-said">Open</span>}
                  {folder.missing && (
                    <>
                      <span className="folder-said">Not found</span>
                      <button type="button" role="menuitem" className="menu-item folder-remove" aria-label={`Remove ${folderName(folder.root)} from the list`} onClick={() => void window.torno.workspace.forget(folder.root).then(setRecent, () => {})}>
                        Remove
                      </button>
                    </>
                  )}
                </div>
              ))}
              <hr className="menu-rule" />
            </>
          )}
          <button type="button" role="menuitem" className="menu-item" onClick={() => choose('pick')}>
            Open folder…
          </button>
          {example && (
            <button type="button" role="menuitem" className="menu-item" title="Four small objects of torno's own, copied to a temporary folder that is removed when torno quits" onClick={() => choose('example')}>
              Open the example
            </button>
          )}
        </div>
      )}
    </div>
  )
}
