export const REPO: string
export function rewriteLink(href: string, docs?: string): string
export function slug(text: string, taken?: Map<string, number>): string
export function renderManual(markdown: string): { html: string; headings: { depth: number; id: string; text: string }[] }
export function renderPage(markdown: string): string
