import { useMemo } from 'react'
import { actions, useStore } from '../state/store'
import { colorFor, colorsByName } from '../../shared/palette'

/**
 * The parts of the layout shown: colour, name, an opacity slider that appears
 * on hover, and a switch for visibility. A setting belongs to the part's name,
 * so it holds in every layout.
 */
export function Layers() {
  const scene = useStore((s) => s.scene)
  const layout = useStore((s) => s.layout)
  const layers = useStore((s) => s.layers)
  // The same assignment as the viewport's, so a swatch matches its part.
  const colors = useMemo(() => colorsByName((scene?.parts ?? []).map((p) => p.name)), [scene])
  if (!scene) return null
  const parts = scene.parts.filter((p) => p.layout === layout)

  return (
    <section className="section layers" aria-label="Layers">
      <h2 className="section-title">Layers</h2>
      {parts.length === 0 && <p className="section-note">This layout has no parts.</p>}
      <ul className="rows">
        {parts.map((part) => {
          const { name } = part
          const layer = layers[name]
          const visible = layer?.visible !== false
          const opacity = layer?.opacity ?? 1
          return (
            <li key={part.key} className="row layer-row" data-layer={name} data-hidden={visible ? undefined : ''}>
              <span
                className="swatch"
                style={{ background: layer?.color ?? colors.get(name) ?? colorFor(name, -1) }}
                aria-hidden="true"
              />
              <span className="row-name num">{name}</span>
              <input
                type="range"
                className="layer-opacity"
                data-set={opacity < 1 ? '' : undefined}
                min={0.1}
                max={1}
                step={0.05}
                value={opacity}
                aria-label={`Opacity of ${name}`}
                title={`Opacity ${Math.round(opacity * 100)} %`}
                onChange={(e) => actions.setLayer(name, { opacity: Number(e.target.value) })}
              />
              <button
                type="button"
                className="icon-button"
                aria-pressed={visible}
                aria-label={`Show ${name}`}
                title={visible ? 'Hide' : 'Show'}
                onClick={() => actions.setLayer(name, { visible: !visible })}
              >
                <EyeIcon open={visible} />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
      <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
      <circle cx="8" cy="8" r="1.75" />
      {!open && <path d="M3 13 13 3" />}
    </svg>
  )
}
