/**
 * Paths a sync or a store never carries: credentials and keys, and paths
 * that would escape their folder. The harness sync (remote/harnessSet.ts)
 * and the skills store (skills.ts) read the same rules. No runtime imports:
 * the renderer reads these too.
 */

const SECRET_NAMES = new Set(['.credentials.json', 'auth.json', 'settings.local.json', '.claude.json'])
const SECRET_EXT = /\.(pem|key|p8|p12|pfx)$/i

/** Credentials and keys: excluded from every manifest and refused on landing, whatever the rules say. */
export function isSecretPath(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath
  return SECRET_NAMES.has(base) || SECRET_EXT.test(base)
}

/** A relPath as the wire may carry it: posix, normalized, relative, no `..`, no `.`, no empty segment. */
export function validRelPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1024) return false
  if (relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/')) return false
  // With no empty, `.` or `..` segment the path is already what posix.normalize gives.
  return relPath.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}
