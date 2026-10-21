/**
 * Deploy drift: how far a host's running build is behind master. Every
 * green master commit bumps release.json `n` (package.json `1.0.N`), each
 * host says its `n` in the hello, and the Mac's main process reads master's
 * release.json from GitHub (src/main/deployDrift.ts). The mark is the
 * difference, shown only when it is known and positive.
 */

/** What a host runs, as its hello says it (src/main/buildInfo.ts). */
export interface BuildFacts {
  /** release.json `n` of the build. */
  release: number
  /** `1.0.N`. */
  version: string
  /** The commit the build came from; null when the build recorded none. */
  sha: string | null
  /** `process.platform` of the host: darwin publishes, anything else deploys. */
  platform: string
}

/** Master's release.json as the Mac last read it (src/main/deployDrift.ts). */
export interface MasterRelease {
  /** release.json `n` on master. */
  release: number
  /** `1.0.N`. */
  version: string
  fetchedAt: number
}

/** `master − running`, floored at zero; null until both numbers are known. */
export function behindCount(master: number | null | undefined, running: number | null | undefined): number | null {
  if (!Number.isInteger(master) || !Number.isInteger(running)) return null
  return Math.max(0, (master as number) - (running as number))
}

export function releaseVersion(n: number): string {
  return `1.0.${n}`
}

/** What brings a host up to master: the box is deployed by hand over ssh, the Mac app is published. */
export type DriftHostKind = 'box' | 'mac'

export const DRIFT_COMMANDS: Record<DriftHostKind, string> = {
  box: "ssh box 'box-update master'",
  mac: 'bun run release:publish'
}

/** The mark's text: `+3`. */
export function driftMark(behind: number): string {
  return `+${behind}`
}

/** The mark's tooltip: the count, both versions and the command that closes the gap. */
export function driftTitle(input: { behind: number; running: number; master: number; kind: DriftHostKind }): string {
  const releases = input.behind === 1 ? 'release' : 'releases'
  const verb = input.kind === 'mac' ? 'Publish' : 'Deploy'
  return `${input.behind} ${releases} behind master (runs v${releaseVersion(input.running)}, master is v${releaseVersion(input.master)}). ${verb} with: ${DRIFT_COMMANDS[input.kind]}`
}

/** A darwin host publishes the app; anything else is a box deployed over ssh. */
export function driftKindOf(platform: string | null | undefined): DriftHostKind {
  return platform === 'darwin' ? 'mac' : 'box'
}
