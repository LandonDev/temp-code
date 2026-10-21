import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import type { Store } from './db'

/**
 * Where new workspaces go on this host, for a client that cannot open a
 * folder dialog here (another desktop, the phone). The setting
 * `workspace.root` wins; else the agent host's `/srv/agents/work` when it
 * exists (docs/box.md); else the home directory. `fs.listPath` and
 * `fs.createPath` then browse and make folders under it over the link.
 * An isolated instance (TEMP_CODE_USER_DATA) takes TEMP_CODE_WORK_ROOT first.
 */

export const WORK_ROOT_SETTING = 'workspace.root'
export const BOX_WORK_ROOT = '/srv/agents/work'

export interface WorkRoot {
  root: string
  home: string
  hostname: string
  platform: NodeJS.Platform
  /** False when the configured root is missing on disk; the client then types a path. */
  exists: boolean
}

export function workRoot(store: Pick<Store, 'getSetting'>, env: { platform?: NodeJS.Platform; home?: string; exists?: (p: string) => boolean } = {}): WorkRoot {
  const exists = env.exists ?? existsSync
  const home = env.home ?? homedir()
  // TEMP_CODE_WORK_ROOT: an isolated instance's root (a proof's two hosts with their own work dirs).
  const configured =
    (process.env.TEMP_CODE_USER_DATA ? process.env.TEMP_CODE_WORK_ROOT?.trim() : undefined) ||
    store.getSetting(WORK_ROOT_SETTING)?.trim()
  const root = configured || (exists(BOX_WORK_ROOT) ? BOX_WORK_ROOT : home)
  return { root, home, hostname: hostname(), platform: env.platform ?? process.platform, exists: exists(root) }
}
