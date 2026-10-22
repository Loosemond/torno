import type { ReactNode } from 'react'
import type { ColumnSection } from '../state/column'
import { actions, useStore } from '../state/store'
import { numbered } from './numbered'
import { giveKeysBack } from './typing'

/**
 * The title of a section of the left column above the marks, as a button that folds it. Folded, the title row says
 * what matters of what the section holds (`said`, its numbers in the monospace face), and the button's name stays the
 * section's: what it says is its description. What sits beside the title (`children`: Import scan…, All objects) stays
 * there folded or not. Folded with the pointer, the keys go back to the view. Where the section cannot fold for now
 * (`still`: the list of objects while the page of objects is up), the title is a word, and what is beside it stays.
 */
export function SectionTitle({ section, title, said, still = false, children }: { section: ColumnSection; title: string; said?: string; still?: boolean; children?: ReactNode }) {
  const folded = useStore((s) => s.column.folded[section])
  return (
    <div className="section-head">
      <h2 className="section-title">
        {still ? (
          title
        ) : (
          <button
            type="button"
            className="section-fold"
            aria-expanded={!folded}
            aria-label={title}
            aria-description={folded ? said : undefined}
            title={folded ? `Unfold ${title.toLowerCase()}` : `Fold ${title.toLowerCase()}`}
            onClick={(e) => {
              actions.foldSection(section, !folded)
              // A click of the pointer (a press of Enter or Space has no count): the next letter is the view's.
              if (e.detail > 0) giveKeysBack(e.currentTarget)
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={folded ? 'M6.25 4.5 9.75 8l-3.5 3.5' : 'M4.5 6.25 8 9.75l3.5-3.5'} />
            </svg>
            {title}
            {folded && said !== undefined && <span className="section-said">{numbered(said)}</span>}
          </button>
        )}
      </h2>
      {children}
    </div>
  )
}
