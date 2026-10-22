import { actions, runningSession, useStore } from '../state/store'
import { insertIntoSession } from './insertIntoSession'
import { numbered } from './numbered'
import { paramRow, type ParamRow } from './paramRows'
import { SectionTitle } from './SectionTitle'

/**
 * The model's `Params`, as the kernel read them at the last build: a row for each field, in the model's order, with
 * its default in the monospace face, its comment as written, and, for a default that is not a literal, that it is
 * worked out in the model. Read only: torno never writes the model, and a row only puts `Params.<name>` at the
 * cursor of the open object's session (the way the selection's "Insert" puts a ref there), for the person to write
 * around ("make Params.wall 2.4"). With no session running the rows are text and say why. A row's name stays
 * `Params.<name>`; what it holds (type, value whole, comment) and what a click does are its description, as a folded
 * section's title does it. The comment is as written, its numbers in the monospace face. A model with no
 * fields, or a kernel that does not read them, has no section.
 */
export function ParamsPanel() {
  const params = useStore((s) => s.scene?.params)
  const folded = useStore((s) => s.column.folded.params)
  const canInsert = useStore((s) => runningSession(s) !== undefined)
  if (!params || params.length === 0) return null
  return (
    <section className="section params" aria-label="Parameters" data-folded={folded ? '' : undefined}>
      <SectionTitle section="params" title="Parameters" said={`${params.length}`} />
      {!folded && (
        <ul className="rows">
          {params.map((param) => (
            <ParamItem key={param.name} row={paramRow(param)} canInsert={canInsert} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ParamItem({ row, canInsert }: { row: ParamRow; canInsert: boolean }) {
  const body = (
    <>
      <span className="param-line">
        <span className="param-name num">{row.name}</span>
        {row.value !== null && (
          <span className="param-value num" title={row.full ?? undefined}>
            {row.value}
          </span>
        )}
      </span>
      {row.doc && <span className="param-doc">{numbered(row.doc)}</span>}
      {row.worked && <span className="param-worked">worked out in the model</span>}
    </>
  )
  return (
    <li className="param-row" data-param={row.name} data-worked={row.worked ? '' : undefined}>
      {canInsert ? (
        <button
          type="button"
          className="param-button"
          aria-label={row.text}
          aria-description={`${row.title}. Put it in the session's prompt`}
          title={row.title}
          onClick={() => {
            // The dock may be away: the box takes no focus in a hidden one.
            actions.setDockOpen(true)
            insertIntoSession(row.text, { later: true })
          }}
        >
          {body}
        </button>
      ) : (
        <div className="param-button" aria-description={`${row.title}. Start a session to put ${row.text} in its prompt`} title={row.title}>
          {body}
        </div>
      )}
    </li>
  )
}
