/**
 * The URL shapes the `tempcode-asset://` protocol serves. Main resolves
 * `logo/<name>` against `<userData>/project-logos` and
 * `page/<sessionId>/<pageId>.html` against `<userData>/html-renders`; the
 * preload bridge builds the same strings synchronously so image `src`
 * attributes need no round trip.
 */
export const ASSET_SCHEME = 'tempcode-asset'

/** The userData subdirectory agent HTML pages are stored under. */
export const HTML_RENDERS_DIR = 'html-renders'

export function logoAssetUrl(absolutePath: string): string {
  const name = absolutePath.split('/').pop() ?? absolutePath
  return `${ASSET_SCHEME}://logo/${encodeURIComponent(name)}`
}

export function pageAssetUrl(sessionId: string, pageId: string): string {
  return `${ASSET_SCHEME}://page/${encodeURIComponent(sessionId)}/${encodeURIComponent(pageId)}.html`
}
