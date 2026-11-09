/**
 * The end-state reads of the benchmark's own tasks (computerTasks.ts's
 * settings-toggle, save-dialog and devapp-form; docs/computer-protocol.md
 * "The benchmark"): System Settings' one switch through `defaults`, a
 * TextEdit save through the files, a dev instance's add-on through its
 * database. Never the model's word. Each takes the runner's `Exec`, so the
 * tests run them over recorded facts on the box.
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface Check {
  ok: boolean
  detail: string
}

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

/** A command's exit, output and errors; it never throws for a non-zero exit. */
export const exec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) })
    })
  })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Is the app with this bundle id running? Asked without launching it. */
export async function isAppRunning(run: Exec, bundleId: string): Promise<boolean> {
  const r = await run('osascript', ['-e', `application id "${bundleId}" is running`])
  return r.code === 0 && r.stdout.trim() === 'true'
}

// ── settings-toggle ─────────────────────────────────────────────────────

export const SYSTEM_SETTINGS = 'com.apple.systempreferences'
/** Sound → "Play feedback when volume is changed": harmless, invisible, put back after. */
export const FEEDBACK_KEY = 'com.apple.sound.beep.feedback'

/** The switch's value in NSGlobalDomain; a missing key reads 0, as System Settings reads it. */
export async function readFeedback(run: Exec): Promise<number> {
  const r = await run('defaults', ['read', '-g', FEEDBACK_KEY])
  if (r.code === 0) {
    const v = Number(r.stdout.trim())
    if (Number.isFinite(v)) return v
    throw new Error(`defaults read -g ${FEEDBACK_KEY} answered ${JSON.stringify(r.stdout.trim())}`)
  }
  if (/does not exist/.test(r.stderr)) return 0
  throw new Error(`defaults read -g ${FEEDBACK_KEY} failed: ${r.stderr.trim()}`)
}

export async function writeFeedback(run: Exec, value: number): Promise<void> {
  const r = await run('defaults', ['write', '-g', FEEDBACK_KEY, '-int', String(value)])
  if (r.code !== 0) throw new Error(`defaults write -g ${FEEDBACK_KEY} failed: ${r.stderr.trim()}`)
}

export const otherFeedback = (value: number): number => (value ? 0 : 1)

/** The switch reads `want`: read every 250 ms for up to 2 s, the time cfprefsd may take to answer the new value. */
export async function feedbackReads(run: Exec, want: number, opts: { timeoutMs?: number; everyMs?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<Check> {
  const { timeoutMs = 2000, everyMs = 250, wait = sleep } = opts
  let got = await readFeedback(run)
  for (let waited = 0; got !== want && waited < timeoutMs; waited += everyMs) {
    await wait(everyMs)
    got = await readFeedback(run)
  }
  return got === want ? { ok: true, detail: `the switch reads ${want}` } : { ok: false, detail: `the switch reads ${got}, not ${want}` }
}

// ── save-dialog ─────────────────────────────────────────────────────────

export const saveSourceText = (nonce: string): string => `Bench ${nonce} copy source`
export const SAVE_TARGET_OLD = 'old'
export const saveTargetName = (nonce: string): string => `${nonce}-target.rtf`

/** A one-line RTF file, written through textutil as TextEdit would write it. */
export async function writeRtf(run: Exec, path: string, text: string): Promise<void> {
  const txt = `${path}.txt`
  writeFileSync(txt, text + '\n')
  const r = await run('textutil', ['-convert', 'rtf', '-output', path, txt])
  if (r.code !== 0) throw new Error(`textutil -convert rtf failed: ${r.stderr.trim()}`)
  await run('rm', ['-f', txt])
}

/** A document's plain text through textutil. */
export async function rtfText(run: Exec, path: string): Promise<string | null> {
  const r = await run('textutil', ['-convert', 'txt', '-stdout', path])
  return r.code === 0 ? r.stdout.replace(/\n+$/, '') : null
}

/** Where a stray save would land: Documents, the Desktop, TextEdit's iCloud folder. */
export const strayRoots = (home: string): string[] => [
  join(home, 'Documents'),
  join(home, 'Desktop'),
  join(home, 'Library', 'Mobile Documents', 'com~apple~TextEdit')
]

/** The paths named with the nonce that sit under a stray root. */
export const straysUnder = (paths: readonly string[], home: string): string[] =>
  paths.filter((p) => strayRoots(home).some((root) => p === root || p.startsWith(root + '/')))

/**
 * Files named with the nonce anywhere Spotlight has indexed, through
 * `mdfind`: reading Documents or the Desktop directly from under TempCode.app
 * could put a folder-access prompt on the person's screen.
 */
export async function spotlightNamed(run: Exec, nonce: string): Promise<string[]> {
  const r = await run('mdfind', ['-name', nonce])
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
}

/** The target holds the source's text, the source is untouched, and no file named with the nonce landed in a stray root. */
export async function checkSaveCopy(opts: {
  run: Exec
  nonce: string
  source: string
  sourceBytes: Buffer
  target: string
  home: string
  named?: (nonce: string) => Promise<string[]>
}): Promise<Check> {
  const want = saveSourceText(opts.nonce)
  const got = await rtfText(opts.run, opts.target)
  if (got === null) return { ok: false, detail: 'the target cannot be read' }
  if (got !== want) return { ok: false, detail: `the target holds ${JSON.stringify(got.slice(0, 80))}` }
  let now: Buffer
  try {
    now = readFileSync(opts.source)
  } catch {
    return { ok: false, detail: 'the source document is gone' }
  }
  if (!now.equals(opts.sourceBytes)) return { ok: false, detail: 'the source document changed' }
  const strays = straysUnder(await (opts.named ?? ((n) => spotlightNamed(opts.run, n)))(opts.nonce), opts.home)
  if (strays.length) return { ok: false, detail: `a copy landed outside the run's folder: ${strays.join(', ')}` }
  return { ok: true, detail: 'saved over the target' }
}

// ── devapp-form ─────────────────────────────────────────────────────────

export const DEV_ADDON_URL = 'http://127.0.0.1:9/mcp'
export const devAddonName = (nonce: string): string => `bench-${nonce}`
/** The database a dev instance opens under its userData (src/main/index.ts). */
export const devDatabase = (userData: string): string => join(userData, 'temp-code.db')

/** The instance's add-on of that name, read straight from its database file, read only. */
export function readAddonRows(dbPath: string, name: string): { workspaceId: string | null; spec: Record<string, unknown> }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare('SELECT workspace_id, spec FROM addons WHERE name = ?').all(name) as { workspace_id: string | null; spec: string }[]
    return rows.map((r) => ({ workspaceId: r.workspace_id, spec: JSON.parse(r.spec) as Record<string, unknown> }))
  } finally {
    db.close()
  }
}

/** One add-on of the name: http, the bench's url, for every workspace. */
export function checkDevAddon(dbPath: string, name: string): Check {
  let rows: ReturnType<typeof readAddonRows>
  try {
    rows = readAddonRows(dbPath, name)
  } catch (err) {
    return { ok: false, detail: `the instance's database cannot be read: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (rows.length !== 1) return { ok: false, detail: rows.length ? `${rows.length} add-ons named ${name}` : `no add-on named ${name}` }
  const [row] = rows
  if (row.spec.transport !== 'http') return { ok: false, detail: `the add-on is ${String(row.spec.transport)}, not http` }
  if (row.spec.url !== DEV_ADDON_URL) return { ok: false, detail: `its url is ${JSON.stringify(row.spec.url)}` }
  if (row.workspaceId !== null) return { ok: false, detail: `it is for one workspace (${row.workspaceId}), not every one` }
  return { ok: true, detail: `${name} added` }
}
