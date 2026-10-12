import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setInstalledCodexVersion } from '@shared/catalog'
import { harnessEnv, resolveBinary } from './binaries'

const execFileP = promisify(execFile)

/**
 * Which codex CLI is installed, read once per boot (`codex --version` →
 * "codex-cli 0.162.1") and stamped onto the shared catalog, so rows the
 * install cannot run are hidden rather than failing at first use. Null when
 * codex is missing or will not answer. Forgotten after `providers.update`.
 */
let probe: Promise<string | null> | null = null

/** Pure: the dotted version in a `--version` line, else null. */
export function parseCodexVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(stdout)?.[1] ?? null
}

export function installedCodexVersion(): Promise<string | null> {
  probe ??= (async () => {
    const path = await resolveBinary('codex')
    if (!path) return null
    try {
      const { stdout } = await execFileP(path, ['--version'], { env: await harnessEnv(), timeout: 15_000 })
      return parseCodexVersion(stdout)
    } catch {
      return null
    }
  })().then((version) => {
    setInstalledCodexVersion(version)
    if (version) console.log(`[catalog] codex ${version}`)
    return version
  })
  return probe
}

/** After an update of the CLI: the next read asks again. */
export function forgetCodexVersion(): void {
  probe = null
}
