import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPage } from './manual-page.mjs'

// The manual as a page: docs/manual.md rendered to <out>/index.html with docs/images beside it.
//   node app/scripts/build-manual.mjs site/manual
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const out = resolve(process.argv[2] ?? join(root, 'site/manual'))
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'index.html'), renderPage(readFileSync(join(root, 'docs/manual.md'), 'utf8')))
cpSync(join(root, 'docs/images'), join(out, 'images'), { recursive: true })
console.log(`manual page: ${out}/index.html`)
