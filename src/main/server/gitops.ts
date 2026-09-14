import { execFileChildBudgeted } from './spawnBudget'
import { lstat, open, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  GitBranches, GitChangedFile, GitDiffIndex, GitDiffStats, GitFileDiff,
  GitLogEntry, GitRangeContext, GitStagedContext
} from '@shared/contract-fsgit'

const MAX_TEXT_BYTES = 8 * 1024 * 1024
const rootPath = (cwd: string): string => resolve(cwd === '~' ? homedir() : cwd.startsWith('~/') ? join(homedir(), cwd.slice(2)) : cwd)

/** No shell; stdin stays separate from arguments for index-only hunk staging. */
function run(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    void execFileChildBudgeted('git', ['--no-pager', '-C', rootPath(cwd), ...args], {
      encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...(args.includes('--') ? { GIT_LITERAL_PATHSPECS: '1' } : {}) }
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString().trim() || stdout.toString().trim() || error.message))
      else resolveOutput(stdout as Buffer)
    }).then((child) => {
      child.stdin?.on('error', () => { /* execFile reports early process exit. */ })
      child.stdin?.end(input)
    })
  })
}
const text = async (cwd: string, args: string[]): Promise<string> => (await run(cwd, args)).toString('utf8')
const optional = async (cwd: string, args: string[]): Promise<string | null> => text(cwd, args).catch(() => null)
const value = async (cwd: string, args: string[]): Promise<string | null> => (await optional(cwd, args))?.trim() || null
const checked = async (cwd: string, args: string[]): Promise<void> => { await run(cwd, args) }
const headBranch = (cwd: string): Promise<string | null> => value(cwd, ['symbolic-ref', '--short', 'HEAD'])
const branch = async (cwd: string): Promise<string | null> => (await headBranch(cwd)) ?? value(cwd, ['rev-parse', '--short', 'HEAD'])
const isWorkTree = async (cwd: string): Promise<boolean> => (await value(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'
const refExists = async (cwd: string, ref: string): Promise<boolean> => (await optional(cwd, ['show-ref', '--verify', '--quiet', ref])) !== null

function repoPath(relative: string): string {
  const rel = relative.replace(/\\/g, '/')
  if (!rel || isAbsolute(rel) || rel.split('/').some((p) => !p || p === '..') || rel.includes('\0')) throw new Error('Invalid path')
  return rel
}
async function requireRepo(cwd: string): Promise<void> {
  if (!(await isWorkTree(cwd))) throw new Error('Not a git repository')
}
async function remoteName(cwd: string): Promise<string | null> {
  const names = (await value(cwd, ['remote']))?.split('\n') ?? []
  return names.includes('origin') ? 'origin' : names[0] ?? null
}
async function defaultBranch(cwd: string, remote: string | null): Promise<string | null> {
  if (remote) {
    const head = await value(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])
    if (head) return head.slice(head.indexOf('/') + 1)
    for (const name of ['main', 'master']) if (await refExists(cwd, `refs/remotes/${remote}/${name}`)) return name
  }
  for (const name of ['main', 'master']) if (await refExists(cwd, `refs/heads/${name}`)) return name
  return null
}
async function aheadBehind(cwd: string, base: string): Promise<{ ahead: number; behind: number }> {
  const counts = (await value(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`]))?.split(/\s+/).map(Number)
  return { ahead: counts?.[1] ?? 0, behind: counts?.[0] ?? 0 }
}

interface FileAcc { additions: number; deletions: number; staged: boolean; unstaged: boolean; untracked: boolean }
function entry(files: Map<string, FileAcc>, rel: string): FileAcc {
  let acc = files.get(rel)
  if (!acc) { acc = { additions: 0, deletions: 0, staged: false, unstaged: false, untracked: false }; files.set(rel, acc) }
  return acc
}
function addNumstat(output: string, files: Map<string, FileAcc>): void {
  const fields = output.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i])
    if (!match) continue
    // -z rename records carry old/new names in the next two fields.
    const rel = match[3] || fields[(i += 2)]
    if (!rel) continue
    const acc = entry(files, rel)
    acc.additions += match[1] === '-' ? 0 : Number(match[1])
    acc.deletions += match[2] === '-' ? 0 : Number(match[2])
  }
}
async function limitedFile(path: string, limit: number): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  const file = await open(path, 'r')
  try {
    const meta = await file.stat()
    if (!meta.isFile()) return { bytes: Buffer.alloc(0), tooLarge: false }
    const bytes = Buffer.alloc(Math.min(meta.size, limit + 1))
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    return { bytes: bytes.subarray(0, length), tooLarge: meta.size > limit || length > limit }
  } finally { await file.close() }
}
async function untracked(cwd: string, files: Map<string, FileAcc>): Promise<void> {
  const names = (await optional(cwd, ['ls-files', '-o', '--exclude-standard', '-z', '--', '.'])) ?? ''
  for (const rel of names.split('\0').filter(Boolean)) {
    const acc = entry(files, rel)
    acc.untracked = true
    if (acc.additions) continue
    try {
      const { bytes, tooLarge } = await limitedFile(join(rootPath(cwd), rel), 1024 * 1024)
      if (!tooLarge && bytes.length && !bytes.includes(0)) {
        acc.additions = bytes.reduce((n, b) => n + Number(b === 10), 0) + Number(bytes.at(-1) !== 10)
      }
    } catch { /* Unreadable untracked files still appear, with zero line counts. */ }
  }
}
async function changes(cwd: string): Promise<{ files: Map<string, FileAcc>; bases: string[][] }> {
  const files = new Map<string, FileAcc>()
  const head = await optional(cwd, ['diff', '--no-ext-diff', '--numstat', '-z', 'HEAD', '--', '.'])
  const bases = head === null ? [[], ['--cached']] : [['HEAD']]
  if (head !== null) addNumstat(head, files)
  else for (const base of bases) addNumstat((await optional(cwd, ['diff', '--no-ext-diff', '--numstat', '-z', ...base, '--', '.'])) ?? '', files)
  await untracked(cwd, files)
  return { files, bases }
}
export async function gitDiffStats(cwd: string): Promise<GitDiffStats> {
  if (!(await isWorkTree(cwd))) return { files: 0, additions: 0, deletions: 0 }
  const { files } = await changes(cwd)
  return { files: files.size, additions: [...files.values()].reduce((n, f) => n + f.additions, 0), deletions: [...files.values()].reduce((n, f) => n + f.deletions, 0) }
}
export async function gitDiffIndex(cwd: string): Promise<GitDiffIndex> {
  const { files, bases } = await changes(cwd)
  const statuses = new Map<string, string>()
  for (const base of bases) {
    const fields = ((await optional(cwd, ['diff', '--no-ext-diff', '--name-status', '--no-renames', '-z', ...base, '--', '.'])) ?? '').split('\0')
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = ({ A: 'added', D: 'deleted', M: 'modified', T: 'modified' } as Record<string, string>)[fields[i]]
      if (status) statuses.set(fields[i + 1], status)
    }
  }
  for (const staged of [true, false]) {
    const names = (await optional(cwd, ['diff', ...(staged ? ['--cached'] : []), '--name-only', '--no-renames', '-z', '--', '.'])) ?? ''
    for (const name of names.split('\0').filter(Boolean)) entry(files, name)[staged ? 'staged' : 'unstaged'] = true
  }
  const out: GitChangedFile[] = []
  for (const [relative, acc] of files) {
    const path = join(rootPath(cwd), relative)
    out.push({ path, relative, status: acc.untracked ? 'untracked' : statuses.get(relative) ?? ((await stat(path).catch(() => null)) ? 'modified' : 'deleted'), additions: acc.additions, deletions: acc.deletions, staged: acc.staged, unstaged: acc.untracked || acc.unstaged })
  }
  out.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)
  const remote = await remoteName(cwd)
  const upstream = await value(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  const defaultName = await defaultBranch(cwd, remote)
  const defaultRef = remote && defaultName ? `${remote}/${defaultName}` : null
  const counts = upstream || defaultRef ? await aheadBehind(cwd, upstream ?? defaultRef!) : { ahead: 0, behind: 0 }
  return { branch: await branch(cwd), files: out, additions: out.reduce((n, f) => n + f.additions, 0), deletions: out.reduce((n, f) => n + f.deletions, 0), remote, upstream, defaultBranch: defaultName, ...counts, aheadOfDefault: defaultRef ? (await aheadBehind(cwd, defaultRef)).ahead : counts.ahead }
}
export async function gitFileDiff(cwd: string, relative: string, base: 'index' | 'HEAD' = 'index'): Promise<GitFileDiff> {
  relative = repoPath(relative)
  await requireRepo(cwd)
  const path = join(rootPath(cwd), relative)
  const prefix = (await value(cwd, ['rev-parse', '--show-prefix'])) ?? ''
  const spec = `${base === 'HEAD' ? 'HEAD' : ''}:${prefix}${relative}`
  const size = await value(cwd, ['cat-file', '-s', spec])
  const inIndex = size !== null
  const originalTooLarge = Number(size) > MAX_TEXT_BYTES
  const original = inIndex && !originalTooLarge ? await run(cwd, ['cat-file', '-p', spec]) : Buffer.alloc(0)
  const current = await limitedFile(path, MAX_TEXT_BYTES).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return { bytes: Buffer.alloc(0), tooLarge: false }
    throw error
  })
  const meta = await stat(path).catch(() => null)
  const binary = original.includes(0) || current.bytes.includes(0)
  const tooLarge = originalTooLarge || current.tooLarge
  return { path, relative, status: !inIndex ? (meta?.isFile() ? 'untracked' : 'deleted') : !meta ? 'deleted' : 'modified', original: binary || tooLarge ? '' : original.toString('utf8'), current: binary || tooLarge ? '' : current.bytes.toString('utf8'), binary, tooLarge }
}
export async function gitStageFile(cwd: string, relative: string): Promise<void> { await checked(cwd, ['add', '--', repoPath(relative)]) }
export async function gitStageContents(cwd: string, relative: string, contents: string): Promise<void> {
  relative = repoPath(relative)
  if (Buffer.byteLength(contents) > MAX_TEXT_BYTES) throw new Error('File too large')
  const hash = (await run(cwd, ['hash-object', '-w', '--path', relative, '--stdin'], contents)).toString().trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) throw new Error('git hash-object returned an invalid hash')
  const mode = (await value(cwd, ['ls-files', '--stage', '--', relative]))?.match(/^\d{6}/)?.[0] ?? '100644'
  const prefix = (await value(cwd, ['rev-parse', '--show-prefix'])) ?? ''
  await checked(cwd, ['update-index', '--add', '--cacheinfo', mode, hash, `${prefix}${relative}`])
}
export async function gitUnstageFile(cwd: string, relative: string): Promise<void> { await checked(cwd, ['restore', '--staged', '--', repoPath(relative)]) }
export async function gitDiscardFile(cwd: string, relative: string): Promise<void> {
  relative = repoPath(relative)
  await requireRepo(cwd)
  if (await optional(cwd, ['ls-files', '--error-unmatch', '--', relative]) === null) {
    const path = join(rootPath(cwd), relative)
    const meta = await lstat(path).catch(() => null)
    if (meta?.isFile() || meta?.isSymbolicLink()) await unlink(path)
    else if (meta) await checked(cwd, ['clean', '-fd', '--', relative])
    return
  }
  await checked(cwd, ['restore', '--worktree', '--', relative])
}
export async function gitStageAll(cwd: string): Promise<void> { await checked(cwd, ['add', '-A', '--', '.']) }
export async function gitUnstageAll(cwd: string): Promise<void> { await checked(cwd, ['restore', '--staged', '--', '.']) }
export async function gitCommitStaged(cwd: string, message: string): Promise<void> {
  if (!message.trim()) throw new Error('Commit message cannot be empty')
  await checked(cwd, ['commit', '--cleanup=strip', '-m', message.trim()])
}
export async function gitStagedContext(cwd: string): Promise<GitStagedContext> {
  let summary = (await optional(cwd, ['diff', '--cached', '--stat', '--', '.'])) ?? ''
  let patch = (await optional(cwd, ['diff', '--cached', '--no-ext-diff', '--', '.'])) ?? ''
  if (!summary.trim() && !patch.trim()) {
    summary = (await optional(cwd, ['diff', 'HEAD', '--stat', '--', '.'])) ?? ''
    patch = (await optional(cwd, ['diff', 'HEAD', '--no-ext-diff', '--', '.'])) ?? ''
    const names = await value(cwd, ['ls-files', '--others', '--exclude-standard'])
    if (names) summary += `${summary.trim() ? '\n' : ''}Untracked files:\n${names}`
  }
  if (!summary.trim() && !patch.trim()) throw new Error('No changes to summarize')
  return { branch: await branch(cwd), summary, patch }
}
export async function gitPush(cwd: string): Promise<void> {
  if (await value(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'])) return checked(cwd, ['push'])
  const remote = await remoteName(cwd)
  if (!remote) throw new Error('No git remote to push to')
  await checked(cwd, ['push', '-u', remote, 'HEAD'])
}
export async function gitPull(cwd: string): Promise<void> { await checked(cwd, ['pull', '--ff-only']) }
export async function gitSync(cwd: string): Promise<void> {
  if (await value(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'])) {
    await checked(cwd, ['pull', '--no-edit', '--ff'])
    await checked(cwd, ['push'])
  } else await gitPush(cwd)
}
export async function gitRangeContext(cwd: string): Promise<GitRangeContext> {
  const head = await branch(cwd)
  if (!head) throw new Error('Not on a branch')
  const remote = await remoteName(cwd)
  const base = await defaultBranch(cwd, remote)
  if (!base) throw new Error('Could not resolve the default branch')
  const baseRef = remote && await refExists(cwd, `refs/remotes/${remote}/${base}`) ? `${remote}/${base}` : base
  const commitSummary = await text(cwd, ['log', '--format=%s', `${baseRef}..HEAD`])
  const diffSummary = await text(cwd, ['diff', '--stat', `${baseRef}...HEAD`])
  const diffPatch = await text(cwd, ['diff', '--no-ext-diff', `${baseRef}...HEAD`])
  if (!commitSummary.trim() && !diffPatch.trim()) throw new Error('No commits to include in a pull request')
  return { base, head, commitSummary, diffSummary, diffPatch }
}
export async function gitBranches(cwd: string): Promise<GitBranches> {
  if (!(await isWorkTree(cwd))) return { current: null, detached: false, branches: [] }
  const currentBranch = await headBranch(cwd)
  const current = currentBranch ?? await value(cwd, ['rev-parse', '--short', 'HEAD'])
  const branches: GitBranches['branches'] = []
  const names = new Set<string>()
  const local = await text(cwd, ['for-each-ref', '--format=%(refname:short)%09%(HEAD)', 'refs/heads'])
  for (const line of local.split('\n').filter(Boolean)) {
    const [name, marker] = line.split('\t')
    names.add(name)
    branches.push({ name, current: marker.trim() === '*', remote: null })
  }
  if (currentBranch && !names.has(currentBranch)) { names.add(currentBranch); branches.push({ name: currentBranch, current: true, remote: null }) }
  const remotes = await text(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
  for (const full of remotes.split('\n').filter(Boolean)) {
    const slash = full.indexOf('/')
    const remote = full.slice(0, slash)
    const name = full.slice(slash + 1)
    if (slash < 1 || name === 'HEAD' || name.endsWith('/HEAD') || names.has(name)) continue
    branches.push({ name, current: false, remote })
  }
  branches.sort((a, b) => Number(b.current) - Number(a.current) || Number(!!a.remote) - Number(!!b.remote) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.remote ?? '').localeCompare(b.remote ?? ''))
  return { current, detached: !currentBranch && !!current, branches }
}
async function branchName(cwd: string, name: string): Promise<string> {
  name = name.trim()
  if (!name) throw new Error('Branch name cannot be empty')
  const normalized = await value(cwd, ['check-ref-format', '--branch', name])
  if (!normalized) throw new Error(`'${name}' is not a valid branch name`)
  return normalized
}
async function switchBranch(cwd: string, args: string[]): Promise<void> {
  try { await checked(cwd, args) } catch (error) {
    if (error instanceof Error && /would be overwritten|commit your changes or stash|please move or remove them before/i.test(error.message)) throw new Error('Your local changes would be overwritten. Commit or stash them first.')
    throw error
  }
}
export async function gitCheckout(cwd: string, name: string, remote?: string | null): Promise<string> {
  await requireRepo(cwd)
  name = await branchName(cwd, name)
  if (await headBranch(cwd) === name) return name
  if (remote?.trim()) {
    if (remote.trim().startsWith('-')) throw new Error('Invalid remote')
    await switchBranch(cwd, ['checkout', '--track', `${remote.trim()}/${name}`])
  } else if (await refExists(cwd, `refs/heads/${name}`)) await switchBranch(cwd, ['checkout', name])
  else {
    const selectedRemote = await remoteName(cwd)
    if (!selectedRemote || !(await refExists(cwd, `refs/remotes/${selectedRemote}/${name}`))) throw new Error(`Branch ${name} not found`)
    await switchBranch(cwd, ['checkout', '--track', `${selectedRemote}/${name}`])
  }
  return name
}
export async function gitCreateBranch(cwd: string, name: string): Promise<string> {
  await requireRepo(cwd)
  name = await branchName(cwd, name)
  if (await refExists(cwd, `refs/heads/${name}`) || await headBranch(cwd) === name) throw new Error(`Branch ${name} already exists`)
  await switchBranch(cwd, ['checkout', '-b', name])
  return name
}
export async function gitStash(cwd: string, message?: string | null): Promise<void> {
  await requireRepo(cwd)
  await checked(cwd, ['stash', 'push', '--include-untracked', ...(message?.trim() ? ['-m', message.trim()] : [])])
}
export async function gitClone(url: string, parent: string): Promise<string> {
  url = url.trim()
  if (!/^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(url)) throw new Error('Enter an https, ssh, or git URL')
  const name = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).at(-1)?.trim()
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Could not infer repository name from URL')
  const dest = join(rootPath(parent), name)
  if (await lstat(dest).catch(() => null)) throw new Error(`${dest} already exists`)
  try { await checked(parent, ['clone', '--', url, dest]) } catch (error) {
    throw new Error(error instanceof Error ? error.message.trim().split('\n').at(-1) : 'git clone failed')
  }
  return dest
}
export async function gitLog(cwd: string, limit = 50): Promise<GitLogEntry[]> {
  await requireRepo(cwd)
  if (!(await value(cwd, ['rev-parse', '--verify', 'HEAD']))) return []
  const output = await text(cwd, ['log', `-${Math.max(1, Math.min(limit, 100))}`, '--format=%H%x00%h%x00%s%x00%an%x00%aI'])
  return output.trimEnd().split('\n').filter(Boolean).map((line) => {
    const [hash, short, subject, author, date] = line.split('\0')
    return { hash, short, subject, author, date }
  })
}
