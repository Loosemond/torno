import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { drawAlignPoints } from './alignPoints'

/** A 2D context that keeps what was drawn on it. */
function canvas() {
  const drawn: Array<{ what: string; at: [number, number]; text?: string; fill?: string; stroke?: string }> = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    at: [0, 0] as [number, number],
    save() {},
    restore() {},
    beginPath() {},
    arc(x: number, y: number) {
      this.at = [x, y]
    },
    fill() {
      drawn.push({ what: 'dot', at: this.at, fill: this.fillStyle })
    },
    stroke() {
      drawn.push({ what: 'ring', at: this.at, stroke: this.strokeStyle })
    },
    fillText(text: string, x: number, y: number) {
      drawn.push({ what: 'text', at: [x, y], text, fill: this.fillStyle })
    }
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn }
}

describe('the points of an alignment being made', () => {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  camera.position.set(0, 0, 100)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const size = { width: 200, height: 200 }
  const colours = { accent: '#1D46B8', paper: '#FAF9F6' }

  it('are numbered dots where each is seen: a scan end filled, a model end a ring, in the accent colour', () => {
    const { ctx, drawn } = canvas()
    drawAlignPoints(ctx, [{ at: [0, 0, 0], label: '1' }, { at: [25, 25, 0], label: '1', hollow: true }], camera, size, colours)
    expect(drawn.filter((d) => d.what === 'dot').map((d) => [d.at, d.fill])).toEqual([[[100, 100], '#1D46B8'], [[150, 50], '#FAF9F6']])
    expect(drawn.filter((d) => d.what === 'text').map((d) => [d.text, d.at, d.fill])).toEqual([['1', [100, 100], '#FAF9F6'], ['1', [150, 50], '#1D46B8']])
    expect(drawn.filter((d) => d.what === 'ring').every((d) => d.stroke === '#1D46B8' || d.stroke === '#FAF9F6')).toBe(true)
  })

  it('draws nothing of a point behind the camera, and nothing at all for none', () => {
    const { ctx, drawn } = canvas()
    drawAlignPoints(ctx, [{ at: [0, 0, 5000], label: '2' }], camera, size, colours)
    drawAlignPoints(ctx, [], camera, size, colours)
    expect(drawn).toEqual([])
  })
})
