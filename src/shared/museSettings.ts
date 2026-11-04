/**
 * The pure rules of a Muse account's config dir (main/server/museConfigDirs.ts):
 * `<userData>/muse-accounts/<account>/` is what a thread's `muse serve` gets
 * as XDG_CONFIG_HOME, so its `muse/auth.json` is that account's login while
 * everything else the CLI keeps under its config root (settings.json, skills,
 * hooks, trust.json, …) is the person's own, reached through symlinks into
 * the real `~/.config/muse`. One login per dir, one dir per account.
 */

/** A file-system safe directory name for an account (an email, usually). */
export function museAccountDirName(account: string): string {
  const safe = account
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@+-]+/g, '_')
    .replace(/^\.+/, '_')
  return safe || '_'
}

/** The entries of the real config dir that are NOT copied per account: the
 *  login and the CLI's lock beside it. Everything else is shared through a
 *  symlink, so a skill or settings edit reaches every account at once. */
export const MUSE_PRIVATE_ENTRIES = new Set(['auth.json', '.auth.json.lock'])

export function isSharedMuseEntry(name: string): boolean {
  if (MUSE_PRIVATE_ENTRIES.has(name)) return false
  // the CLI's own temp files beside auth.json
  if (/^auth\.json\.\d+\.tmp$/.test(name) || name.endsWith('.aliax-prelogin')) return false
  return true
}
