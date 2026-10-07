import { randomBytes } from 'node:crypto'
import { PREVIEW_PAGE_PREFIX } from './htmlPreviewPolicy'

/**
 * The pages the hidden preview window is looking at, held in memory for the
 * asset protocol to serve as `tempcode-asset://page/preview/<token>.html`.
 * Never file: (the window must not read local files) and never data: (a
 * data: main frame gets an opaque origin that breaks the bootstrap's
 * history.replaceState).
 */
const pages = new Map<string, string>()

export function previewPageHtml(token: string): string | undefined {
  return pages.get(token)
}

export function holdPreviewPage(html: string): { url: string; release: () => void } {
  const token = randomBytes(12).toString('hex')
  pages.set(token, html)
  return { url: `${PREVIEW_PAGE_PREFIX}${token}.html`, release: () => pages.delete(token) }
}
