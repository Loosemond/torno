import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { type ExportData, type ExportObject, packMesh } from '../../shared/exportdata'
import { POLICY, type PageAssets, exportHtml } from './html'

const ASSETS: PageAssets = { viewer: 'window.__ran = "</script><b>"', css: 'body{margin:0}', fonts: [{ family: 'IBM Plex Sans', weight: 400, woff2: new Uint8Array([1, 2, 3]) }] }

const mesh = (() => {
  const { header, bytes } = packMesh({ positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), triangles: new Uint32Array([0, 1, 2]), edges: new Float32Array([0, 0, 0, 10, 0, 0]) })
  return { ...header, data: deflateSync(bytes, { level: 9 }).toString('base64') }
})()

function data(over: Partial<ExportData> = {}, object: Partial<ExportObject> = {}): ExportData {
  const part = (name: string) => ({ name, layout: 'assembly', loc: { t: [0, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] }, bbox: { min: [0, 0, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] }, color: '#7B93B4', opacity: 1, visible: true, faces: 1, mesh: 'h' })
  return {
    format: 'torno-export',
    version: 1,
    title: 'hollow · r3',
    exportedAt: '2026-10-09T21:14:03.000Z',
    dropped: [],
    objects: [{ id: 'hollow', name: 'hollow', revision: 3, layouts: ['assembly'], layout: 'assembly', parts: [part('tray'), part('lid')], meshes: { h: mesh }, explode: {}, views: [], ...object }],
    ...over
  }
}

const jsonOf = (html: string): string => /<script type="application\/json" id="torno-data">(.*?)<\/script>/s.exec(html)![1]

describe('exportHtml', () => {
  it('is one file that fetches nothing and closes no script early', () => {
    const html = exportHtml(data({ title: 'a </script> <b>title</b>' }), ASSETS)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`)
    // Two scripts and no more: the data and the viewer.
    expect(html.match(/<script/g)).toHaveLength(2)
    expect(html.match(/<\/script>/g)).toHaveLength(2)
    expect(html).not.toMatch(/\b(?:src|href)\s*=/)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).toContain('<title>a &lt;/script&gt; &lt;b&gt;title&lt;/b&gt;</title>')
    expect(html).toContain("url(data:font/woff2;base64,AQID) format('woff2')")
    expect(JSON.parse(jsonOf(html)).title).toBe('a </script> <b>title</b>')
  })

  it('allows the page no eval, no worker, no frame, no connection and no form', () => {
    expect(POLICY).not.toMatch(/unsafe-eval|connect-src|frame-src|worker-src|form-action|\*|https?:/)
    expect(POLICY.startsWith("default-src 'none'")).toBe(true)
  })

  it('keeps names and notes that would break out of the data where they are: text', () => {
    const hostile = '</script><script>alert(1)</script><!-- <![CDATA[ \u2028\u2029 &amp; "\' \\u003c </SCRIPT >'
    const note = { id: 'M1', kind: 'pin' as const, author: 'user' as const, layout: 'assembly', note: hostile, status: 'sent' as const, at: [0, 0, 0] as [number, number, number] }
    const view = { name: hostile.slice(0, 40), author: 'user' as const, layout: hostile, camera: { position: [0, 0, 1] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], ortho: false, fov: 35, zoom: 1 }, hidden: [hostile], at: '' }
    const given = data({ title: hostile, dropped: [hostile] }, { id: hostile, name: hostile, layouts: [hostile], layout: hostile, marks: [note], views: [view] })
    const html = exportHtml(given, ASSETS)
    const json = jsonOf(html)
    // Nothing in the data opens or closes a tag or a comment, and no line ends in it for a script that reads it as one.
    expect(json).not.toMatch(/[<\u2028\u2029]/)
    expect(JSON.parse(json)).toEqual(given)
    expect(html.match(/<script/gi)).toHaveLength(2)
    expect(html.match(/<\/script/gi)).toHaveLength(2)
    expect(html).not.toContain('<!--')
    expect(html).toContain('<title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;!-- &lt;![CDATA[ \u2028\u2029 &amp;amp; "\' \\u003c &lt;/SCRIPT &gt;</title>')
  })

  it('lets neither the viewer nor the style close its own element', () => {
    const html = exportHtml(data(), { ...ASSETS, viewer: 'var a = "</SCRIPT>" + "<!--" + "<script"', css: 'a::after{content:"</style><script>x</script>"}' })
    expect(html.match(/<\/script>/gi)).toHaveLength(2)
    expect(html.match(/<\/style/gi)).toHaveLength(1)
    expect(html.match(/<script/gi)).toHaveLength(2)
    expect(html).not.toContain('<!--')
  })
})
