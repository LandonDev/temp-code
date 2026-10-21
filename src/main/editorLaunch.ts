import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { commandPathProbe, loginShell } from './server/loginShell'

/**
 * Open a file in the user's editor: IntelliJ IDEA (`idea --line N path`),
 * VS Code (`code -g path:N`) or Xcode (`xed -l N path`). The editor is the
 * `editor.command` setting (idea | code | xed; absent means auto: the
 * first of those installed), with one exception: a Swift file under an
 * `ios/` folder opens in Xcode when Xcode is the configured editor or
 * IDEA is not installed. Electron-free: the IPC in index.ts hands in the
 * settings store and the spawner, and the tests stub both.
 */

import {
  EDITOR_IDS,
  EDITOR_LABELS,
  chooseEditor,
  isSwiftUnderIos,
  type EditorChoice,
  type EditorConfig,
  type EditorId,
  type EditorTarget
} from '../shared/editor'

export { chooseEditor, isSwiftUnderIos }
export type { EditorChoice, EditorConfig, EditorId, EditorTarget }
export const EDITOR_SETTING_KEY = 'editor.command'

/** Where each launcher lives on a Mac when the shell cannot find it. */
const KNOWN_PATHS: Record<EditorId, string[]> = {
  idea: [
    '/usr/local/bin/idea',
    '/opt/homebrew/bin/idea',
    '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
    '/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea'
  ],
  code: [
    '/usr/local/bin/code',
    '/opt/homebrew/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
  ],
  xed: ['/usr/bin/xed']
}

export interface EditorLaunchDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
  /** The launcher's path when the editor is installed, else null. */
  resolve(editor: EditorId): Promise<string | null>
  /** Start the launcher detached; it must not block on the editor. */
  spawn(command: string, args: string[]): Promise<void>
}

export const isEditorId = (value: unknown): value is EditorId =>
  typeof value === 'string' && (EDITOR_IDS as readonly string[]).includes(value)

export function editorChoice(raw: string | null | undefined): EditorChoice {
  return isEditorId(raw) ? raw : 'auto'
}

/**
 * The argument shape of each launcher. Lines and columns are 1-based;
 * without a line the file opens where the editor left it.
 */
export function editorArgs(editor: EditorId, target: EditorTarget): string[] {
  const line = target.line && target.line > 0 ? Math.trunc(target.line) : undefined
  const column = line && target.column && target.column > 0 ? Math.trunc(target.column) : undefined
  switch (editor) {
    case 'idea':
      return line
        ? ['--line', String(line), ...(column ? ['--column', String(column)] : []), target.path]
        : [target.path]
    case 'code':
      return ['-g', line ? `${target.path}:${line}${column ? `:${column}` : ''}` : target.path]
    case 'xed':
      return line ? ['-l', String(line), target.path] : [target.path]
  }
}

export class EditorLauncher {
  private readonly cache = new Map<EditorId, Promise<string | null>>()

  constructor(private readonly deps: EditorLaunchDeps) {}

  choice(): EditorChoice {
    return editorChoice(this.deps.getSetting(EDITOR_SETTING_KEY))
  }

  setChoice(choice: EditorChoice): void {
    this.deps.setSetting(EDITOR_SETTING_KEY, choice === 'auto' ? null : choice)
  }

  /** The launcher path, resolved once per editor for the process's life. */
  private launcher(editor: EditorId): Promise<string | null> {
    let pending = this.cache.get(editor)
    if (!pending) {
      pending = this.deps.resolve(editor).catch(() => null)
      this.cache.set(editor, pending)
    }
    return pending
  }

  /** Forget what was resolved (after the user installs an editor). */
  refresh(): void {
    this.cache.clear()
  }

  async installed(): Promise<Record<EditorId, boolean>> {
    const found = await Promise.all(EDITOR_IDS.map((id) => this.launcher(id)))
    return { idea: found[0] !== null, code: found[1] !== null, xed: found[2] !== null }
  }

  async config(): Promise<EditorConfig> {
    const installed = await this.installed()
    const editor = this.choice()
    return { editor, installed, effective: chooseEditor(editor, installed, 'file.ts') }
  }

  /** Open the file; resolves to the editor used, rejects when none is installed. */
  async open(target: EditorTarget): Promise<{ editor: EditorId }> {
    const installed = await this.installed()
    const editor = chooseEditor(this.choice(), installed, target.path)
    if (!editor) throw new Error('No editor found: install IntelliJ IDEA, VS Code or Xcode, or pick one in Settings')
    const command = await this.launcher(editor)
    if (!command) throw new Error(`${EDITOR_LABELS[editor]} is not installed`)
    await this.deps.spawn(command, editorArgs(editor, target))
    return { editor }
  }
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/** The login shell's answer for `name`, else the first known path that exists. */
export async function resolveEditorPath(
  editor: EditorId,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const fromShell = await new Promise<string | null>((done) => {
    const shell = loginShell(env, platform)
    execFile(shell, ['-lc', commandPathProbe(editor, shell)], { timeout: 5_000 }, (err, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').pop() ?? ''
      done(!err && line.startsWith('/') ? line : null)
    })
  })
  if (fromShell) return fromShell
  for (const candidate of KNOWN_PATHS[editor]) if (await exists(candidate)) return candidate
  return null
}

/** Start the launcher and let it go: the editor outlives this process. */
export function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 15_000 }, (err) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error(`${command}: not found`))
    })
    child.once('error', reject)
    child.once('spawn', () => resolve())
    child.unref()
  })
}

export function defaultEditorLaunchDeps(store: Pick<EditorLaunchDeps, 'getSetting' | 'setSetting'>): EditorLaunchDeps {
  return {
    getSetting: (key) => store.getSetting(key),
    setSetting: (key, value) => store.setSetting(key, value),
    resolve: (editor) => resolveEditorPath(editor),
    spawn: spawnDetached
  }
}
