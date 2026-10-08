import { useStore } from '../state/store'

/** The objects of the workspace. One that cannot be built is muted, with the reason as its tooltip. */
export function ObjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const objects = useStore((s) => s.workspace?.objects ?? NONE)
  const openId = useStore((s) => s.objectId)

  return (
    <nav className="section objects" aria-label="Objects">
      <h2 className="section-title">Objects</h2>
      {objects.length === 0 ? (
        <p className="section-note">No objects here yet. An object is a folder with a Python model in it.</p>
      ) : (
        <ul className="rows">
          {objects.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="row object-row"
                aria-current={o.id === openId ? 'true' : undefined}
                data-problem={o.problem ? '' : undefined}
                title={o.problem}
                onClick={() => onOpen(o.id)}
              >
                <span className="row-name">{o.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

const NONE: never[] = []
