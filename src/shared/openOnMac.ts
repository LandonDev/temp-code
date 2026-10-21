/**
 * Opening a file from a thread on another host in this machine's editor.
 * A box thread's diff, transcript and file tree name box paths; read on the
 * Mac, the file worth opening is the Mac's own copy. The harness sync's
 * path map (scripts/box/history-map.json, or the `harness.sync.pathMap`
 * setting) is Mac → box, so it is inverted here: box
 * `/srv/agents/work/<X>/…` ↔ Mac `~/IdeaProjects/<X>/…`. Pure string work,
 * no node imports: the renderer runs it.
 */

export interface PathMap {
  roots: Record<string, string>
  prefixes: Record<string, string>
}

const clean = (path: string): string => path.replace(/\/+$/, '') || '/'
const under = (path: string, root: string): boolean => path === root || path.startsWith(root === '/' ? '/' : `${root}/`)

/** The table's entries by their destination side, longest first. */
function inverted(table: Record<string, string>): [string, string][] {
  return Object.entries(table)
    .map(([local, remote]): [string, string] => [clean(remote), clean(local)])
    .sort((a, b) => b[0].length - a[0].length)
}

/**
 * The local (Mac) path of a path on the mapped host: by root, else by the
 * longest prefix, else null when no entry covers it. A relative path is
 * never mapped.
 */
export function localPathOf(map: PathMap, remotePath: string): string | null {
  if (!remotePath.startsWith('/')) return null
  const target = clean(remotePath)
  for (const table of [inverted(map.roots), inverted(map.prefixes)]) {
    for (const [remote, local] of table) if (under(target, remote)) return local + target.slice(remote.length)
  }
  return null
}

/** The mapped path of a local path on the host (the map's own direction). */
export function remotePathOf(map: PathMap, localPath: string): string | null {
  if (!localPath.startsWith('/')) return null
  const target = clean(localPath)
  const forward = (table: Record<string, string>): [string, string][] =>
    Object.entries(table)
      .map(([local, remote]): [string, string] => [clean(local), clean(remote)])
      .sort((a, b) => b[0].length - a[0].length)
  for (const table of [forward(map.roots), forward(map.prefixes)]) {
    for (const [local, remote] of table) if (under(target, local)) return remote + target.slice(local.length)
  }
  return null
}

export type OpenDecision =
  /** The Mac's copy matches the host's: open it in the editor. */
  | { kind: 'local'; localPath: string }
  /** The Mac has the project but not this file (another branch checked out here). */
  | { kind: 'missing'; localPath: string; localProject: string }
  /** The Mac has the file but its content differs from the host's. */
  | { kind: 'differs'; localPath: string }
  /** Nothing maps the path to this Mac, or the mapped project is not checked out here. */
  | { kind: 'absent'; localPath: string | null }

export interface OpenEvidence {
  /** The file's path here, or null when the map has no entry for it. */
  localPath: string | null
  /** The project root here (the thread's cwd mapped), or null. */
  localProject: string | null
  /** True when `localProject` is a directory on this machine. */
  localProjectExists: boolean
  /** sha256 of the host's copy, null when it is gone there too. */
  remoteDigest: string | null
  /** sha256 of the copy here, null when there is none. */
  localDigest: string | null
}

/**
 * What to do with one file: the editor when the Mac's copy is the same
 * bytes, the app's own read-only preview with a note otherwise. A file the
 * host no longer has (deleted in its diff) is still shown here when the
 * Mac has it, as the Mac's copy.
 */
export function decideOpen(evidence: OpenEvidence): OpenDecision {
  const { localPath, localProject, localProjectExists, remoteDigest, localDigest } = evidence
  if (!localPath) return { kind: 'absent', localPath: null }
  if (localDigest === null) {
    return localProject && localProjectExists ? { kind: 'missing', localPath, localProject } : { kind: 'absent', localPath }
  }
  if (remoteDigest !== null && remoteDigest !== localDigest) return { kind: 'differs', localPath }
  return { kind: 'local', localPath }
}

/** The one-line note the preview's header carries for a decision that did not open the editor. */
export function decisionNote(decision: OpenDecision, branch: string | null, hostName: string): string | null {
  const here = branch ? `: on branch ${branch} here` : ''
  switch (decision.kind) {
    case 'local':
      return null
    case 'missing':
      return `No Mac copy${here}`
    case 'differs':
      return `Mac copy differs${here}`
    case 'absent':
      return decision.localPath ? 'Not checked out on the Mac' : `Only on ${hostName}`
  }
}
