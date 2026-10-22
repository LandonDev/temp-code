import { basename, isAbsolute, resolve } from 'node:path'
import type { ThreadResourceKind } from '@shared/contract-resources'

/**
 * What a command created or removed, read from the command and what it
 * printed (docs/box.md "Thread resources"). Pure: the same parser serves a
 * local Bash-like tool call (the harness's tool-call + tool-result events),
 * a mac.run over the bridge (argv or command string, exit code, stdout and
 * stderr) and a mac.run job's rolling output. The rule throughout is that
 * nothing is recorded that the command did not demonstrably create: a git
 * worktree needs its "Preparing worktree" line (or a clean exit when the
 * exit code is known), a simulator needs the UDID simctl printed, a dev
 * instance needs its TEMP_CODE_USER_DATA.
 */

export interface Created {
  kind: ThreadResourceKind
  /** worktree: absolute path; simulator: UDID (or the name when only that is known); devInstance: the userData dir. */
  identifier: string
  label: string
  /** worktree: the branch the command made (null: an existing branch or detached, so nothing to delete). */
  branch: string | null
  /** port: the listening pid and the tool call that opened it. */
  pid?: number | null
  callId?: string | null
}

export interface Removed {
  kind: ThreadResourceKind
  /** The identifier as the command named it: a path (absolute), a UDID or a simulator name. */
  identifier: string
}

export interface Detected {
  created: Created[]
  removed: Removed[]
}

export interface CommandInput {
  /** argv as the harness or the bridge had it, or a shell command string. */
  argv?: string[]
  command?: string
  cwd: string
  /** The home the command's host expands `~` and `$HOME` to. */
  home: string
  /** Everything the command printed (stdout and stderr, in any order). */
  output: string
  /** Known for a bridged run; a tool-result event does not carry it. */
  exitCode?: number | null
}

const UUID = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/i

const none = (): Detected => ({ created: [], removed: [] })

/** One simple command of a shell line: its words (assignments and `env` prefix dropped), the raw words, and the cwd `cd` tracking gave it. */
export interface Simple {
  words: string[]
  raw: string[]
  cwd: string
}

/**
 * Split a shell command string into simple commands on `&&`, `||`, `;`,
 * `|` and newlines, respecting quotes and backslashes; `$(…)`, backticks
 * and subshell parentheses are not expanded, their text stays in the word.
 * Variable assignments and `env` prefixes are dropped from `words` (kept in
 * `raw`); `cd` moves the cwd for the commands after it.
 */
export function simpleCommands(command: string, cwd: string, home: string): Simple[] {
  const out: Simple[] = []
  let dir = cwd
  for (const raw of splitSegments(command)) {
    const words = stripPrefix(raw)
    if (!words.length) continue
    if (words[0] === 'cd') {
      const target = words[1]
      dir = target ? expand(target, dir, home) : home
      continue
    }
    out.push({ words, raw, cwd: dir })
  }
  return out
}

/** The raw splitter: words per simple command, quotes and backslashes honoured, nothing expanded. */
function splitSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: "'" | '"' | null = null
  let depth = 0
  const endWord = (): void => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (): void => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
      continue
    }
    if (c === '(') {
      depth++
      if (depth === 1 && !inWord) continue
      word += c
      inWord = true
      continue
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1)
      if (depth === 0 && word === '') continue
      word += c
      inWord = true
      continue
    }
    if (depth > 0) {
      if (/\s/.test(c)) endWord()
      else {
        word += c
        inWord = true
      }
      continue
    }
    if (c === '\n' || c === ';') {
      endSegment()
      continue
    }
    if (c === '&' || c === '|') {
      endSegment()
      if (command[i + 1] === c) i++
      continue
    }
    if (/\s/.test(c)) {
      endWord()
      continue
    }
    word += c
    inWord = true
  }
  endSegment()
  return segments
}

/** Drop `VAR=value` assignments and an `env [-i] [-u NAME] [VAR=value]` prefix. */
function stripPrefix(words: string[]): string[] {
  let i = 0
  const assignment = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)
  while (i < words.length && assignment(words[i])) i++
  if (words[i] === 'env') {
    i++
    while (i < words.length) {
      const w = words[i]
      if (w === '-u' || w === '--unset') i += 2
      else if (w === '-i' || w === '-' || w.startsWith('--ignore') || assignment(w)) i++
      else break
    }
  }
  while (i < words.length && assignment(words[i])) i++
  return words.slice(i)
}

/** The assignments ahead of a simple command (what `TEMP_CODE_USER_DATA=… bun run dev` sets). */
function assignmentsOf(words: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  const take = (w: string): boolean => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w)
    if (!m) return false
    out[m[1]] = m[2]
    return true
  }
  while (i < words.length && take(words[i])) i++
  if (words[i] === 'env') {
    i++
    while (i < words.length) {
      const w = words[i]
      if (w === '-u' || w === '--unset') i += 2
      else if (w === '-i' || w === '-' || w.startsWith('--ignore')) i++
      else if (take(w)) i++
      else break
    }
  }
  return out
}

/** `~`, `$HOME`, `${HOME}` and a relative path against the cwd. */
export function expand(path: string, cwd: string, home: string): string {
  let p = path
  if (p === '~') p = home
  else if (p.startsWith('~/')) p = home + p.slice(1)
  p = p.replace(/^\$\{HOME\}|^\$HOME\b/, home)
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])

/** The `git` invocation's subcommand words, with -C applied to the cwd. */
function gitArgs(words: string[], cwd: string, home: string): { args: string[]; cwd: string } | null {
  if (basename(words[0] ?? '') !== 'git') return null
  let dir = cwd
  let i = 1
  while (i < words.length) {
    const w = words[i]
    if (!w.startsWith('-')) break
    if (w === '-C') {
      if (words[i + 1]) dir = expand(words[i + 1], dir, home)
      i += 2
      continue
    }
    const eq = w.indexOf('=')
    const name = eq > 0 ? w.slice(0, eq) : w
    if (GIT_GLOBAL_WITH_VALUE.has(name) && eq < 0) i += 2
    else i++
  }
  return { args: words.slice(i), cwd: dir }
}

const WORKTREE_ADD_WITH_VALUE = new Set(['-b', '-B', '--reason', '--orphan'])

/** `git worktree add [opts] <path> [<commit-ish>]` → the path, the branch flag and whether a commit-ish was named. */
export function parseWorktreeAdd(
  words: string[],
  cwd: string,
  home: string
): { path: string; branchFlag: string | null; commitish: string | null; detach: boolean; orphan: string | null } | null {
  const git = gitArgs(words, cwd, home)
  if (!git || git.args[0] !== 'worktree' || git.args[1] !== 'add') return null
  const rest = git.args.slice(2)
  const positional: string[] = []
  let branchFlag: string | null = null
  let orphan: string | null = null
  let detach = false
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]
    if (w === '--') {
      positional.push(...rest.slice(i + 1))
      break
    }
    if (w.startsWith('-') && w !== '-') {
      const eq = w.indexOf('=')
      const name = eq > 0 ? w.slice(0, eq) : w
      const value = eq > 0 ? w.slice(eq + 1) : rest[i + 1]
      if (name === '--detach') detach = true
      if (name === '-b' || name === '-B') branchFlag = value ?? null
      if (name === '--orphan') orphan = value ?? null
      if (WORKTREE_ADD_WITH_VALUE.has(name) && eq < 0) i++
      continue
    }
    positional.push(w)
  }
  if (!positional[0]) return null
  return {
    path: expand(positional[0], git.cwd, home),
    branchFlag,
    commitish: positional[1] ?? null,
    detach,
    orphan
  }
}

/** `git worktree remove [-f] <path>` → the path. */
function parseWorktreeRemove(words: string[], cwd: string, home: string): string | null {
  const git = gitArgs(words, cwd, home)
  if (!git || git.args[0] !== 'worktree' || git.args[1] !== 'remove') return null
  const target = git.args.slice(2).find((w) => !w.startsWith('-'))
  return target ? expand(target, git.cwd, home) : null
}

/** The words after `simctl` (with or without `xcrun [--sdk …]` ahead of it). */
function simctlArgs(words: string[]): string[] | null {
  let i = 0
  if (basename(words[0] ?? '') === 'xcrun') {
    i = 1
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '--sdk' || words[i] === '--toolchain') i += 2
      else i++
    }
  }
  if (basename(words[i] ?? '') !== 'simctl') return null
  return words.slice(i + 1)
}

/** git's own line: "Preparing worktree (new branch 'x')" / "(checking out 'x')" / "(resetting branch 'x'; …)" / "(detached HEAD abc)". */
export function worktreePreparedLine(output: string): { kind: 'new' | 'existing' | 'detached'; branch: string | null } | null {
  const m = /Preparing worktree \((new branch|checking out|resetting branch|detached HEAD)(?: '([^']*)')?/.exec(output)
  if (!m) return null
  if (m[1] === 'new branch') return { kind: 'new', branch: m[2] ?? null }
  if (m[1] === 'detached HEAD') return { kind: 'detached', branch: null }
  return { kind: 'existing', branch: m[2] ?? null }
}

const FAILED = /^(fatal|error):/m

/** Did the command run through? A known exit code decides; otherwise git's and simctl's own failure lines do. */
function succeeded(input: CommandInput): boolean {
  if (input.exitCode !== undefined && input.exitCode !== null) return input.exitCode === 0
  if (input.exitCode === null) return false
  return !FAILED.test(input.output)
}

/** Everything one command (argv or shell string) created or removed. */
export function detectCommand(input: CommandInput): Detected {
  const simples: Simple[] = input.argv?.length
    ? [{ words: stripPrefix(input.argv), raw: input.argv, cwd: input.cwd }]
    : input.command
      ? simpleCommands(input.command, input.cwd, input.home)
      : []
  const out = none()
  const ok = succeeded(input)
  for (const { words, raw, cwd } of simples) {
    if (!words.length) continue
    const wt = parseWorktreeAdd(words, cwd, input.home)
    if (wt) {
      if (!ok) continue
      const prepared = worktreePreparedLine(input.output)
      // With no exit code and no "Preparing worktree" line, the worktree is not known to exist.
      if (input.exitCode === undefined && !prepared) continue
      let branch: string | null = null
      if (prepared) branch = prepared.kind === 'new' ? prepared.branch : null
      else if (wt.orphan) branch = wt.orphan
      else if (wt.branchFlag) branch = wt.branchFlag
      else if (!wt.commitish && !wt.detach) branch = basename(wt.path)
      out.created.push({ kind: 'worktree', identifier: wt.path, label: branch ?? basename(wt.path), branch })
      continue
    }
    const removedPath = parseWorktreeRemove(words, cwd, input.home)
    if (removedPath) {
      if (ok) out.removed.push({ kind: 'worktree', identifier: removedPath })
      continue
    }
    const sim = simctlArgs(words)
    if (sim) {
      if (sim[0] === 'create' && sim[1]) {
        const udid = UUID.exec(input.output)?.[0]
        // Only the UDID simctl printed proves the device exists.
        if (ok && udid) out.created.push({ kind: 'simulator', identifier: udid.toUpperCase(), label: sim[1], branch: null })
      } else if (sim[0] === 'delete' && sim[1] && ok) {
        for (const target of sim.slice(1)) if (!target.startsWith('-')) out.removed.push({ kind: 'simulator', identifier: target })
      }
      // `simctl boot` creates nothing: a booted device the thread made is already on the ledger.
      continue
    }
    const userData = assignmentsOf(raw).TEMP_CODE_USER_DATA
    if (userData && isDevLaunch(words)) {
      if (!ok) continue
      const dir = expand(userData, cwd, input.home)
      out.created.push({ kind: 'devInstance', identifier: dir, label: basename(dir), branch: null })
    }
  }
  return out
}

/** `bun run dev`, `bun dev`, `npm run dev`, `electron-vite dev`: a dev instance launch. */
function isDevLaunch(words: string[]): boolean {
  const w = words.map((x) => basename(x))
  if (w[0] === 'bun' || w[0] === 'npm' || w[0] === 'pnpm' || w[0] === 'yarn') {
    const i = w[1] === 'run' ? 2 : 1
    return /^dev(:|$)/.test(w[i] ?? '') && w[i] !== 'dev:prod'
  }
  return w[0] === 'electron-vite' && w[1] === 'dev'
}

/**
 * The harness's own worktree tool. EnterWorktree's result names the path it
 * made (under .claude/worktrees) and usually the branch; ExitWorktree with
 * `remove` takes it away again. Nothing is read from the input alone: the
 * tool may have refused.
 */
export function detectHarnessWorktree(toolName: string, input: unknown, output: string): Detected {
  const out = none()
  const path = /(\/[^\s'"`()]*\/\.claude\/worktrees\/[^\s'"`(),]+)/.exec(output)?.[1] ?? null
  if (toolName === 'EnterWorktree') {
    if (!path || /^(error|failed|cannot|could not)/im.test(output)) return out
    const branch = /branch[:\s]+['"`]?([^\s'"`,)]+)/i.exec(output)?.[1] ?? null
    const name = (input as { name?: unknown } | null)?.name
    out.created.push({
      kind: 'worktree',
      identifier: path.replace(/\/+$/, ''),
      label: branch ?? (typeof name === 'string' && name ? name : basename(path)),
      branch
    })
  } else if (toolName === 'ExitWorktree') {
    const action = (input as { action?: unknown } | null)?.action
    if (action === 'remove' && path && !/^(error|failed|cannot|could not|refus)/im.test(output))
      out.removed.push({ kind: 'worktree', identifier: path.replace(/\/+$/, '') })
  }
  return out
}

/** The shell command of a Bash-like tool call, whatever the harness calls it. */
export function shellOf(input: unknown): { argv?: string[]; command?: string; cwd?: string } | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const cmd = o.command ?? o.cmd
  const cwd = [o.cwd, o.workdir, o.working_directory, o.workingDirectory].find((v) => typeof v === 'string' && v) as
    | string
    | undefined
  if (Array.isArray(cmd) && cmd.every((w) => typeof w === 'string')) {
    const argv = cmd as string[]
    // codex wraps a shell string as ["bash","-lc","…"]: read the string.
    if (argv.length >= 3 && /^(ba|z|)sh$/.test(basename(argv[0])) && /^-l?c$/.test(argv[1]))
      return { command: argv.slice(2).join(' '), ...(cwd ? { cwd } : {}) }
    return { argv, ...(cwd ? { cwd } : {}) }
  }
  if (typeof cmd === 'string' && cmd) return { command: cmd, ...(cwd ? { cwd } : {}) }
  return null
}
