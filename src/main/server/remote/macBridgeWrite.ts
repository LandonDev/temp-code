import { createHash, randomBytes } from 'node:crypto'
import { constants, existsSync, realpathSync, statSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  MAC_APPROVAL_WAIT_MS,
  MAC_WRITE_MAX_BASE64,
  MacWriteFileWireSchema,
  type MacBridgeOutcome,
  type MacBridgeRequest,
  type MacWriteFileResult,
  type MacWriteFileWire,
  type MacWriteMode
} from '@shared/contract-macbridge'
import { MAC_WRITE_PULL_MS, decodeBase64Strict } from '../macWriteStage'
import { insideRoots, realSpelling } from './fence'
import { isSecretPath } from './harnessSet'
import type { LinkRequest } from './peerCalls'

/**
 * The Mac side of mac.writeFile (docs/box.md "The Mac bridge"): a box thread
 * writes a file on this Mac. MacBridge.handle hands the call here with its
 * prompt, its log and the host's policy read raw:
 *
 *  - off: refused, like every call.
 *  - read: every write asks, and the card offers no remember, so a write is
 *    never prompt-free under read.
 *  - read+run, and any level above it this build does not know yet (full):
 *    a write inside this Mac's managed roots, a shared folder or a folder
 *    remembered for this thread lands at once; any other path asks, with
 *    "allow this folder for this thread" (never home or wider).
 *  - Whatever the level, a path under ~/Library, a dotfile or dot-folder
 *    directly in home (~/.zshrc, ~/.ssh/…), or a key or credential by name
 *    (harnessSet.ts isSecretPath) asks every time and is never remembered.
 *
 * A path is judged by its real spelling (a symlinked parent or file is
 * followed before the verdict, so a link out of a shared folder asks), and
 * the parent is checked again just before the file lands. The write itself
 * is atomic: a temp file beside the target, then rename (overwrite) or link
 * (create, which never replaces anything); append opens the file itself,
 * never through a symlink. Missing folders above the file are made only for
 * create and overwrite. One log line per write: host, thread, path, bytes,
 * mode and the outcome, never the contents.
 */

/** A reply's travel time, as the bridge keeps it for reads. */
const REPLY_MARGIN_MS = 3_000

export type WriteLevel = 'off' | 'ask' | 'write'

/** What a host's policy setting allows of writes: an unknown level above read (another build's `full`) writes. */
export function writeLevel(raw: string | null | undefined): WriteLevel {
  if (!raw || raw === 'off') return 'off'
  return raw === 'read' ? 'ask' : 'write'
}

/** dir is home, or above it: remembering it would admit all of home. */
function coversHome(dir: string, home: string): boolean {
  return dir === sep || dir === home || home.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * Paths a write always asks for, whatever the policy, the shared folders and
 * the remembered ones: under ~/Library, a dotfile or dot-folder directly in
 * home, and a key or credential by name anywhere. Compared case-folded
 * (macOS volumes are case-insensitive by default), by the literal home and
 * its real spelling.
 */
export function writeDenied(real: string, home: string): boolean {
  const path = real.toLowerCase()
  for (const h of new Set([home, realSpelling(home)])) {
    const rel = relative(h.toLowerCase(), path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    const first = rel.split(sep)[0]
    if (first.startsWith('.') || first === 'library') return true
  }
  const base = basename(real)
  return isSecretPath(base) || isSecretPath(base.toLowerCase())
}

export type WriteVerdict =
  | { allow: true; why: 'managed' | 'shared' | 'remembered' }
  | { allow: false; why: 'denied' | 'policy read' | 'outside'; folder: string | null }

/** Whether a write lands without asking, and what remember would admit when it asks. */
export function writeVerdict(
  real: string,
  rules: {
    level: Exclude<WriteLevel, 'off'>
    home: string
    managed: readonly string[]
    shared: readonly string[]
    remembered: readonly string[]
  }
): WriteVerdict {
  if (writeDenied(real, rules.home)) return { allow: false, why: 'denied', folder: null }
  if (rules.level === 'ask') return { allow: false, why: 'policy read', folder: null }
  if (rules.managed.length && insideRoots(real, rules.managed))
    return { allow: true, why: 'managed' }
  if (rules.shared.length && insideRoots(real, rules.shared)) return { allow: true, why: 'shared' }
  if (rules.remembered.length && insideRoots(real, rules.remembered))
    return { allow: true, why: 'remembered' }
  const folder = dirname(real)
  return {
    allow: false,
    why: 'outside',
    folder: coversHome(folder, realSpelling(rules.home)) ? null : folder
  }
}

/** The real path a write lands at: absolute (or ~/… for this Mac's home), symlinks followed. */
export function writeTarget(path: string, home: string): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error(`paths on the Mac must be absolute: ${path}`)
  const real = realSpelling(resolve(expanded))
  if (real === sep) throw new Error('refused: / is not a file')
  return real
}

/** The folder must still be itself, not a symlink swapped in since the verdict. */
function assertRealParent(dir: string): void {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    throw new Error(`no such folder on the Mac: ${dir}`)
  }
  if (real !== dir) throw new Error(`refused: ${dir} moved under a symlink since it was checked`)
}

const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code

/**
 * Write `data` at the real path `dest`: atomically for create and overwrite
 * (temp file + link or rename), appended in place for append. Never follows
 * a symlink at the target, never replaces a file under create.
 */
export async function writeMacFile(
  dest: string,
  data: Buffer,
  mode: MacWriteMode,
  fileMode?: number
): Promise<{ created: boolean }> {
  const dir = dirname(dest)
  const before = await lstat(dest).catch(() => null)
  if (before?.isDirectory()) throw new Error(`a folder is there on the Mac: ${dest}`)
  if (mode === 'create' && before)
    throw new Error(`the file exists on the Mac (mode overwrite replaces it): ${dest}`)
  if (!existsSync(dir)) {
    if (mode === 'append') throw new Error(`no such folder on the Mac: ${dir}`)
    await mkdir(dir, { recursive: true })
  } else if (!statSync(dir).isDirectory()) throw new Error(`not a folder on the Mac: ${dir}`)
  assertRealParent(dir)
  if (mode === 'append') {
    const fh = await open(
      dest,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      fileMode ?? 0o644
    )
    try {
      if (!(await fh.stat()).isFile()) throw new Error(`not a file on the Mac: ${dest}`)
      await fh.writeFile(data)
      if (fileMode !== undefined) await fh.chmod(fileMode)
    } finally {
      await fh.close()
    }
    return { created: !before }
  }
  const tmp = join(
    dir,
    `.${basename(dest).slice(0, 80)}.tc-write-${randomBytes(6).toString('hex')}`
  )
  const finalMode = fileMode ?? (before?.isFile() ? before.mode & 0o777 : 0o644)
  const fh = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    try {
      await fh.writeFile(data)
      await fh.chmod(finalMode)
      await fh.sync()
    } finally {
      await fh.close()
    }
    assertRealParent(dir)
    if (mode === 'overwrite') await rename(tmp, dest)
    else {
      try {
        // link() never replaces: a file that appeared since the check fails here.
        await link(tmp, dest)
      } catch (err) {
        if (errCode(err) === 'EEXIST')
          throw new Error(`the file exists on the Mac (mode overwrite replaces it): ${dest}`)
        // A volume without hard links: an exclusive copy still never replaces.
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'].includes(errCode(err) ?? ''))
          throw err
        await copyFile(tmp, dest, constants.COPYFILE_EXCL)
      }
    }
  } finally {
    await rm(tmp, { force: true })
  }
  return { created: !before }
}

/** The write's bytes: inline, or pulled piece by piece over the link the call came on; checked against size and hash. */
async function bytesOf(wire: MacWriteFileWire, link: LinkRequest | null): Promise<Buffer> {
  let b64: string
  if (wire.dataBase64 !== undefined && !wire.staged) b64 = wire.dataBase64
  else if (wire.staged && wire.dataBase64 === undefined) {
    if (!link) throw new Error('the link to the host went down before the write arrived')
    const parts: string[] = []
    let total = 0
    for (let index = 0; index < wire.staged.chunks; index++) {
      const piece = (await link(
        'peer.pull',
        { stageId: wire.staged.id, index },
        { timeoutMs: MAC_WRITE_PULL_MS }
      )) as { data?: unknown } | null
      if (typeof piece?.data !== 'string') throw new Error('the write arrived damaged')
      total += piece.data.length
      if (total > MAC_WRITE_MAX_BASE64) throw new Error('the write arrived damaged')
      parts.push(piece.data)
    }
    b64 = parts.join('')
  } else throw new Error('the write carries no bytes')
  const data = decodeBase64Strict(b64)
  if (data.length !== wire.size || createHash('sha256').update(data).digest('hex') !== wire.sha256)
    throw new Error('the write arrived damaged')
  return data
}

/** What MacBridge lends a write: its prompt, its log, the host's rules. */
export interface MacWriteHost {
  env: { id: string; name: string }
  thread: { id: string; title: string }
  /** The raw `macBridge.policy.<envId>` setting. */
  policy: string | null
  home: string
  managed: readonly string[]
  shared: readonly string[]
  /** The folders this thread may write in without asking (kept apart from the read folders). */
  remembered: Set<string>
  ask: (
    shape: Omit<MacBridgeRequest, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
    until: number
  ) => {
    id: string
    answer: Promise<{ allow: boolean; remember: boolean; outcome: MacBridgeOutcome }>
  }
  finish: (id: string, outcome: MacBridgeOutcome) => void
  link: LinkRequest | null
  log: (line: string) => void
}

/** Write folders remembered per (bridge, host, thread), in memory: they end with the app, like the read ones. */
const memories = new WeakMap<object, Map<string, Set<string>>>()
export function writeFoldersOf(owner: object, envId: string, sessionId: string): Set<string> {
  let byThread = memories.get(owner)
  if (!byThread) memories.set(owner, (byThread = new Map()))
  const key = `${envId}\0${sessionId}`
  let set = byThread.get(key)
  if (!set) byThread.set(key, (set = new Set()))
  return set
}

/** One mac.writeFile from a box: decide, pull the bytes, write, one log line. */
export async function serveMacWrite(
  host: MacWriteHost,
  raw: unknown,
  deadlineAt: number
): Promise<MacWriteFileResult> {
  const wire = MacWriteFileWireSchema.parse(raw)
  const prefix = `${host.env.name} (${host.env.id}) thread=${host.thread.id} mac.writeFile`
  const level = writeLevel(host.policy)
  if (level === 'off') {
    host.log(`${prefix} bytes=${wire.size} → refused (bridge off)`)
    throw new Error(
      "the Mac bridge is off for this host: turn it on in the Mac's Settings → Remote access"
    )
  }
  const dest = writeTarget(wire.path, host.home)
  const line = (decision: string): void =>
    host.log(`${prefix} path=${dest} bytes=${wire.size} mode=${wire.mode} → ${decision}`)
  const verdict = writeVerdict(dest, {
    level,
    home: host.home,
    managed: host.managed,
    shared: host.shared,
    remembered: [...host.remembered]
  })
  let how: string = verdict.allow ? verdict.why : 'asked'
  if (!verdict.allow) {
    const until = Math.min(
      Date.now() + MAC_APPROVAL_WAIT_MS,
      deadlineAt - MAC_WRITE_PULL_MS - REPLY_MARGIN_MS
    )
    if (until <= Date.now()) {
      line('refused (no time to ask)')
      throw new Error('the call left no time to ask the Mac')
    }
    const { id, answer } = host.ask(
      {
        environmentId: host.env.id,
        hostName: host.env.name,
        sessionId: host.thread.id,
        threadTitle: String(host.thread.title ?? ''),
        kind: 'write',
        method: 'mac.writeFile',
        path: dest,
        ...(verdict.folder ? { folder: verdict.folder } : {}),
        bytes: wire.size,
        writeMode: wire.mode,
        ...(wire.mode !== 'append' && !existsSync(dirname(dest)) ? { createsFolders: true } : {})
      },
      until
    )
    const decision = await answer
    if (!decision.allow) {
      line(decision.outcome)
      throw new Error(
        decision.outcome === 'expired' ? 'nobody at the Mac answered in time' : 'denied at the Mac'
      )
    }
    if (decision.remember && verdict.folder) {
      host.remembered.add(verdict.folder)
      how = 'asked, folder remembered'
    }
    host.finish(id, 'allowed')
  }
  try {
    const data = await bytesOf(wire, host.link)
    const { created } = await writeMacFile(dest, data, wire.mode, wire.fileMode)
    line(`written (${how})`)
    return { path: dest, bytes: data.length, mode: wire.mode, created }
  } catch (err) {
    line(`failed (${how}): ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}
