import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import pageCss from '../../export/page.css?raw'
import type { ExportData } from '../../shared/exportdata'

// The exported page: one file that holds its style, its fonts, its data and its viewer, and asks for nothing.
// Its own policy forbids every request, every `eval` and every frame; what the workspace named (objects, parts,
// views, notes) is in it only as JSON in a script element that is not run, and the viewer sets it as text.

export interface PageAssets { viewer: string; css: string; fonts: Array<{ family: string; weight: number; woff2: Uint8Array }> }

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Nothing from anywhere: scripts and styles only as they are written in the file, pictures and fonts only from the file itself. No `unsafe-eval`. */
export const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"

export function exportHtml(data: ExportData, assets: PageAssets): string {
  const fonts = assets.fonts.map((font) => `@font-face{font-family:'${font.family}';font-weight:${font.weight};font-style:normal;src:url(data:font/woff2;base64,${Buffer.from(font.woff2).toString('base64')}) format('woff2')}`).join('\n')
  // In a script element only `</script` and `<!--` matter: every `<` of the data is written as an escape JSON
  // takes. The two line ends JSON allows bare and older script parsers do not are escaped with it.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  // In the viewer they can only be in strings and regular expressions (the build refuses a bundle that has one
  // at all, `scripts/build-viewer.mjs`): there `\/` and `\x21` are the same characters, in every mode of either.
  const viewer = assets.viewer
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\x21--')
    .replace(/<(script)/gi, (_all, word: string) => `<\\x${word.charCodeAt(0).toString(16)}${word.slice(1)}`)
  const style = `${fonts}\n${assets.css}`.replace(/<\/style/gi, '<\\/style').replace(/<(\/?)script/gi, '<\\$1script').replace(/<!--/g, '<\\!--')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta name="color-scheme" content="light dark">',
    '<meta name="generator" content="torno">',
    `<title>${escapeText(data.title)}</title>`,
    `<style>${style}</style>`,
    '</head>',
    '<body>',
    '<div id="torno"><canvas id="view"></canvas><div id="overlay"></div><aside id="panel"></aside><noscript>This page draws 3D parts with JavaScript.</noscript></div>',
    `<script type="application/json" id="torno-data">${json}</script>`,
    `<script>${viewer}</script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

const FONTS = [
  { family: 'IBM Plex Sans', weight: 400, file: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2' },
  { family: 'IBM Plex Sans', weight: 600, file: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2' },
  { family: 'IBM Plex Mono', weight: 400, file: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2' }
]

let loaded: Promise<PageAssets> | null = null

/**
 * What every page is made of, read once: the viewer the app's build bundled (`out/viewer/viewer.js`, beside
 * `out/main`), the page's style, and the three font files of the app. Rejects with what to do when the viewer
 * was not built.
 */
export function loadAssets(): Promise<PageAssets> {
  loaded ??= (async () => {
    const viewer = await readFile(join(__dirname, '../viewer/viewer.js'), 'utf8').catch(() => {
      throw new Error('The viewer of exported pages was not built: run pnpm build')
    })
    const require = createRequire(__filename)
    const fonts = await Promise.all(FONTS.map(async ({ family, weight, file }) => ({ family, weight, woff2: new Uint8Array(await readFile(require.resolve(file))) })))
    return { viewer, css: pageCss, fonts }
  })()
  // A build that comes later is found: a failure is not kept.
  loaded.catch(() => (loaded = null))
  return loaded
}
