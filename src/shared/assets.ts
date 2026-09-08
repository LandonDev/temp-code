/**
 * The one URL shape the `tempcode-asset://` protocol serves. Main resolves
 * it against `<userData>/project-logos`; the preload bridge builds the same
 * string synchronously so image `src` attributes need no round trip.
 */
export const ASSET_SCHEME = 'tempcode-asset'

export function logoAssetUrl(absolutePath: string): string {
  const name = absolutePath.split('/').pop() ?? absolutePath
  return `${ASSET_SCHEME}://logo/${encodeURIComponent(name)}`
}
