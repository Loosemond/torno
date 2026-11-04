import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'

// A PDF of a drawing of a section: the SVG (`sectionSvg`) printed by Electron's `printToPDF` in a window that is
// never shown (`show: false`, no preload, no node, sandboxed), on a page of the drawing's own size in millimetres, so
// that it is the same drawing at the same scale. The window loads only the data URL it is given; every request that
// is anything else is cancelled.

/** The page of a PDF is at most this many millimetres on a side: a printer's page is never larger, and a plotter's is not asked of this. */
const MOST_MM = 5000

/** The bytes of a PDF of `svg`, a drawing `width` by `height` mm. Rejects with a sentence when it cannot be made. */
export async function pdfOfSvg(svg: string, width: number, height: number): Promise<Buffer> {
  if (!(width > 0 && height > 0 && width <= MOST_MM && height <= MOST_MM)) throw new Error(`The drawing is ${Math.round(width)} by ${Math.round(height)} mm, too large for a page`)
  const own = session.fromPartition(`torno-pdf-${Date.now()}-${randomUUID()}`)
  own.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('data:') }))
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { session: own, contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false, webSecurity: true, backgroundThrottling: false } })
  try {
    const image = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
    const page = `<!doctype html><meta charset="utf-8"><style>@page{size:${width}mm ${height}mm;margin:0}html,body{margin:0;padding:0}img{display:block;width:${width}mm;height:${height}mm}</style><img src="${image}">`
    await win.loadURL(`data:text/html;base64,${Buffer.from(page, 'utf8').toString('base64')}`)
    const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('The printer did not make a PDF')
    return pdf
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
