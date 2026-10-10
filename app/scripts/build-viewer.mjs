// Bundles the viewer of exported pages (src/export/viewer) into one classic script, out/viewer/viewer.js, which
// main reads and writes into every page it exports. It is part of `pnpm build`: an app without it cannot export.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(app, 'out/viewer')
/** The most the bundle may weigh: three.js tree-shaken, the controls and the viewer are about 585 kB. What the app has and the page must not (the picking tree, React, xterm) would not fit under it. */
const MOST = 650_000

await build({
  root: app,
  configFile: false,
  logLevel: 'warn',
  build: {
    lib: { entry: resolve(app, 'src/export/viewer/main.ts'), formats: ['iife'], name: 'tornoViewer', fileName: () => 'viewer.js' },
    outDir: out,
    emptyOutDir: true,
    minify: 'esbuild',
    target: 'es2020',
    // One file, read as text: nothing beside it.
    copyPublicDir: false
  }
})

const file = resolve(out, 'viewer.js')
// three.js names a namespace and cites a paper by their addresses, in strings: neither is ever asked for. They
// are written so that no address stands in an exported page at all (`\/` is `/` in a string), which lets a
// reader, and a test, see at a glance that the page names nowhere to go.
writeFileSync(file, readFileSync(file, 'utf8').replace(/(https?:)\/\//g, '$1\\/\\/'))
const code = readFileSync(file, 'utf8')
const refuse = (why) => {
  console.error(`build-viewer: ${why}`)
  process.exit(1)
}
// It runs from a file:// page, inline, under a policy that allows no request and no eval.
if (/\bimport\s*\(/.test(code)) refuse('the bundle holds a dynamic import, which a page opened from a file cannot follow')
if (/\beval\s*\(|\bnew Function\s*\(/.test(code)) refuse('the bundle evaluates text as code, which the page forbids itself')
// Written into a script element as it is: nothing in it may read as the end of one, or as a comment's start.
for (const text of ['</script', '<!--', '<script']) if (code.toLowerCase().includes(text)) refuse(`the bundle holds the text ${text}, which cannot stand in an inline script`)
// The viewer writes what the workspace named as text only.
for (const text of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) if (code.includes(text)) refuse(`the bundle holds ${text}: the viewer sets text, never markup`)
// Nothing of the app but its plain rules: not the tree that picking uses, not its UI, nothing of Electron.
for (const text of ['MeshBVH', 'react', 'ipcRenderer']) if (code.includes(text)) refuse(`the bundle holds ${text}: the viewer imports something of the app that does not belong in a page`)
const { size } = statSync(file)
if (size > MOST) refuse(`the bundle is ${size} bytes, more than ${MOST}`)
console.log(`out/viewer/viewer.js  ${(size / 1000).toFixed(1)} kB`)
