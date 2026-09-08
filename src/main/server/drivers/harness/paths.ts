/** Path relative to cwd when it lives under the project, otherwise
 *  unchanged. Copied from src/lib/paths.ts — the only piece preview.ts
 *  needs from there. */
export function displayPath(path: string, cwd?: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = cwd?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && base !== '~') {
    if (normalized === base) {
      return normalized.split('/').filter(Boolean).pop() || normalized
    }
    const prefix = `${base}/`
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length)
    }
  }
  return normalized
}
