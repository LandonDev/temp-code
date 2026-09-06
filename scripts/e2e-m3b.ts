/**
 * M3b over the wire: every fs path, git and GitHub method called through
 * the WebSocket against a temp repo (with a local bare remote) and a clone
 * of a public GitHub repo for the gh-backed methods.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startServer, type RunningServer } from '../src/main/server'
import type { ClientRequest } from '../src/shared/contract'

type Frame = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }

class Client {
  readonly ws: WebSocket
  private seq = 0
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`)
    this.ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as Partial<Frame>
      if (!f.id) return
      const w = this.pending.get(f.id)
      if (!w) return
      this.pending.delete(f.id)
      if (f.ok) w.resolve(f.result)
      else w.reject(new Error(String((f as { error: string }).error)))
    })
  }
  ready(): Promise<unknown> { return once(this.ws, 'open') }
  request<T = unknown>(method: ClientRequest['method'], params?: unknown): Promise<T> {
    const id = String(++this.seq)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject })
      this.ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
    })
  }
  async close(): Promise<void> { this.ws.close(); await once(this.ws, 'close') }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })

let failures = 0
const pass = (label: string): void => { console.log(`PASS  ${label}`) }
const fail = (label: string, e: unknown): void => { failures++; console.log(`FAIL  ${label} — ${e instanceof Error ? e.message : String(e)}`) }
const step = async (label: string, fn: () => Promise<void>): Promise<void> => { try { await fn(); pass(label) } catch (e) { fail(label, e) } }

const root = await mkdtemp(join(tmpdir(), 'tc-m3b-'))
const repo = join(root, 'repo')
const bare = join(root, 'remote.git')
let server: RunningServer | undefined
let client: Client | undefined
try {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  await writeFile(join(repo, 'a.txt'), lines.join('\n') + '\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-q', '-u', 'origin', 'main')

  server = await startServer(join(root, 'temp-code.db'))
  client = new Client(server.port)
  await client.ready()
  const c = client

  // ── fs path methods ──
  const a = join(repo, 'a.txt')
  let dir = '', file = '', copy = ''
  await step('fs.listPath lists a.txt with ignored flag', async () => {
    const entries = await c.request<{ name: string; isDir: boolean; ignored: boolean }[]>('fs.listPath', { path: repo })
    assert.ok(entries.some((e) => e.name === 'a.txt' && !e.isDir && e.ignored === false))
    assert.ok(!entries.some((e) => e.name === '.DS_Store'))
  })
  await step('fs.createPath dir + file, fs.writeText / fs.readText round-trip', async () => {
    dir = await c.request<string>('fs.createPath', { parent: repo, name: 'dir', isDir: true })
    assert.equal(dir, join(repo, 'dir'))
    file = await c.request<string>('fs.createPath', { parent: dir, name: 'n.txt', isDir: false })
    await c.request('fs.writeText', { path: file, content: 'hello\n' })
    assert.equal(await c.request('fs.readText', { path: file }), 'hello\n')
    await assert.rejects(c.request('fs.createPath', { parent: dir, name: 'n.txt', isDir: false }))
  })
  await step('fs.readPreview window, fs.statFiles, fs.inspectPaths, fs.readBase64', async () => {
    assert.deepEqual(await c.request('fs.readPreview', { path: a, maxLines: 2, startLine: 3 }), ['line 3', 'line 4'])
    const [st] = await c.request<{ mtimeMs: number | null }[]>('fs.statFiles', { paths: [a] })
    assert.equal(typeof st.mtimeMs, 'number')
    const infos = await c.request<{ path: string; size: number }[]>('fs.inspectPaths', { paths: [a, join(repo, 'missing')] })
    assert.equal(infos.length, 1); assert.equal(infos[0].size, (await stat(a)).size)
    const b64 = await c.request<string>('fs.readBase64', { path: a })
    assert.equal(Buffer.from(b64, 'base64').toString('utf8'), await readFile(a, 'utf8'))
  })
  await step('fs.renamePath / copyPath / movePath / deletePath', async () => {
    file = await c.request<string>('fs.renamePath', { path: file, name: 'm.txt' })
    assert.equal(basename(file), 'm.txt')
    copy = await c.request<string>('fs.copyPath', { from: file, destParent: dir })
    assert.notEqual(copy, file); assert.ok(existsSync(copy))
    const moved = await c.request<string>('fs.movePath', { from: copy, destParent: repo })
    assert.equal(moved, join(repo, basename(copy)))
    await c.request('fs.deletePath', { path: moved })
    assert.ok(!existsSync(moved))
    await assert.rejects(c.request('fs.deletePath', { path: moved }))
  })
  await step('fs.projectFiles lists tracked and untracked, not ignored', async () => {
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n'); await writeFile(join(repo, 'ignored.txt'), 'x')
    const files = await c.request<{ relative: string }[]>('fs.projectFiles', { cwd: repo })
    const rel = files.map((f) => f.relative)
    assert.ok(rel.includes('a.txt') && rel.includes('dir/m.txt') && !rel.includes('ignored.txt'))
  })

  // ── git ──
  await step('git.diffStats clean tree then two-hunk edit', async () => {
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'files')
    assert.deepEqual(await c.request('git.diffStats', { cwd: repo }), { files: 0, additions: 0, deletions: 0 })
    const edited = [...lines]; edited[1] = 'line 2 CHANGED'; edited[27] = 'line 28 CHANGED'
    await writeFile(a, edited.join('\n') + '\n')
    const s = await c.request<{ files: number; additions: number; deletions: number }>('git.diffStats', { cwd: repo })
    assert.equal(s.files, 1); assert.equal(s.additions, 2); assert.equal(s.deletions, 2)
  })
  await step('git.stageContents stages one hunk; diffIndex shows staged+unstaged; commitStaged commits the index only', async () => {
    const oneHunk = [...lines]; oneHunk[1] = 'line 2 CHANGED'
    await c.request('git.stageContents', { cwd: repo, relative: 'a.txt', contents: oneHunk.join('\n') + '\n' })
    const idx = await c.request<{ branch: string | null; files: { relative: string; staged: boolean; unstaged: boolean }[]; upstream: string | null; ahead: number }>('git.diffIndex', { cwd: repo })
    const row = idx.files.find((f) => f.relative === 'a.txt')
    assert.ok(row && row.staged && row.unstaged, JSON.stringify(idx.files))
    assert.equal(idx.branch, 'main'); assert.equal(idx.upstream, 'origin/main')
    const staged = await c.request<{ patch: string }>('git.stagedContext', { cwd: repo })
    assert.ok(staged.patch.includes('line 2 CHANGED') && !staged.patch.includes('line 28 CHANGED'))
    const diff = await c.request<{ original: string; current: string }>('git.fileDiff', { cwd: repo, relative: 'a.txt' })
    assert.ok(diff.original.includes('line 2 CHANGED') && diff.current.includes('line 28 CHANGED'))
    const head = await c.request<{ original: string }>('git.fileDiff', { cwd: repo, relative: 'a.txt', base: 'HEAD' })
    assert.ok(!head.original.includes('CHANGED'))
    await c.request('git.commitStaged', { cwd: repo, message: 'one hunk' })
    const log = await c.request<{ subject: string; hash: string; short: string; author: string; date: string }[]>('git.log', { cwd: repo, limit: 5 })
    assert.equal(log[0].subject, 'one hunk'); assert.equal(log.length, 3)
    assert.equal((await c.request<{ files: number }>('git.diffStats', { cwd: repo })).files, 1)
    assert.equal(git(repo, 'show', 'HEAD:a.txt').includes('line 28 CHANGED'), false)
  })
  await step('git.stageAll / unstageAll / stageFile / unstageFile / discardFile', async () => {
    await c.request('git.stageAll', { cwd: repo })
    assert.ok((await c.request<{ files: { staged: boolean }[] }>('git.diffIndex', { cwd: repo })).files.every((f) => f.staged))
    await c.request('git.unstageAll', { cwd: repo })
    await c.request('git.stageFile', { cwd: repo, relative: 'a.txt' })
    await c.request('git.unstageFile', { cwd: repo, relative: 'a.txt' })
    await c.request('git.discardFile', { cwd: repo, relative: 'a.txt' })
    assert.equal((await c.request<{ files: number }>('git.diffStats', { cwd: repo })).files, 0)
  })
  await step('git.stash removes an untracked file', async () => {
    await writeFile(join(repo, 'wip.txt'), 'wip')
    await c.request('git.stash', { cwd: repo, message: 'wip' })
    assert.ok(!existsSync(join(repo, 'wip.txt')))
    assert.ok(git(repo, 'stash', 'list').includes('wip'))
  })
  await step('git.createBranch / branches / checkout / rangeContext', async () => {
    assert.equal(await c.request('git.createBranch', { cwd: repo, name: 'feat' }), 'feat')
    await assert.rejects(c.request('git.createBranch', { cwd: repo, name: 'feat' }))
    await writeFile(join(repo, 'feat.txt'), 'f'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'feat work')
    const br = await c.request<{ current: string | null; detached: boolean; branches: { name: string; current: boolean; remote: string | null }[] }>('git.branches', { cwd: repo })
    assert.equal(br.current, 'feat'); assert.ok(br.branches.some((b) => b.name === 'main' && b.remote === null))
    const range = await c.request<{ base: string; head: string; commitSummary: string; diffSummary: string }>('git.rangeContext', { cwd: repo })
    assert.equal(range.head, 'feat'); assert.ok(range.commitSummary.includes('feat work'))
    assert.equal(await c.request('git.checkout', { cwd: repo, name: 'main' }), 'main')
  })
  await step('git.push / pull / sync against the bare remote', async () => {
    await writeFile(join(repo, 'p.txt'), 'p'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'push me')
    await c.request('git.push', { cwd: repo })
    assert.ok(execFileSync('git', ['-C', bare, 'log', '--oneline', 'main'], { encoding: 'utf8' }).includes('push me'))
    await c.request('git.pull', { cwd: repo })
    await writeFile(join(repo, 's.txt'), 's'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'sync me')
    await c.request('git.sync', { cwd: repo })
    assert.ok(execFileSync('git', ['-C', bare, 'log', '--oneline', 'main'], { encoding: 'utf8' }).includes('sync me'))
  })
  await step('git.clone refuses a local path (donor: https/ssh/git URLs only); checkout of a remote-tracking branch in a second clone', async () => {
    git(repo, 'push', '-q', 'origin', 'feat')
    await assert.rejects(c.request('git.clone', { url: bare, parent: root }), /https, ssh, or git URL/)
    const cloned = join(root, 'second')
    execFileSync('git', ['clone', '-q', bare, cloned])
    assert.equal(await c.request('git.checkout', { cwd: cloned, name: 'feat', remote: 'origin' }), 'feat')
    assert.ok(existsSync(join(cloned, 'feat.txt')))
  })

  // ── GitHub via gh ──
  let ghOk = false
  try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); ghOk = true } catch { /* not authenticated */ }
  if (!ghOk) {
    await step('github.* reject without gh auth', async () => { await assert.rejects(c.request('github.repo', { cwd: repo })) })
    console.log('SKIP  gh is not authenticated on this machine; GitHub methods only checked for the error path')
  } else {
    let clone = ''
    await step('git.clone of octocat/Hello-World (public); a second clone into the same parent is refused', async () => {
      clone = await c.request<string>('git.clone', { url: 'https://github.com/octocat/Hello-World.git', parent: root })
      assert.ok(existsSync(join(clone, 'README')))
      await assert.rejects(c.request('git.clone', { url: 'https://github.com/octocat/Hello-World.git', parent: root }), /already exists/)
    })
    await step('github.repo resolves the slug', async () => {
      assert.equal(await c.request('github.repo', { cwd: clone }), 'octocat/Hello-World')
    })
    let issues: { number: number; title: string }[] = []
    await step('github.workItems lists open issues (limit 3)', async () => {
      issues = await c.request('github.workItems', { cwd: clone, kind: 'issue', assignedToMe: false, state: 'open', search: '', limit: 3 })
      assert.ok(Array.isArray(issues) && issues.length <= 3)
      console.log(`      → ${issues.length} issues: ${issues.map((i) => `#${i.number}`).join(' ')}`)
    })
    await step('github.details + thread on the first open issue', async () => {
      if (!issues.length) return
      const d = await c.request<{ body: string; author: string; authorAvatarUrl: string }>('github.details', { cwd: clone, kind: 'issue', number: issues[0].number })
      assert.equal(typeof d.body, 'string'); assert.ok(d.author.length > 0)
      const t = await c.request<{ comments: unknown[]; truncated: boolean }>('github.thread', { cwd: clone, kind: 'issue', number: issues[0].number })
      assert.ok(Array.isArray(t.comments)); assert.equal(typeof t.truncated, 'boolean')
      console.log(`      → issue #${issues[0].number} by ${d.author}: ${t.comments.length} comments`)
    })
    await step('github.prStatus on master of the clone', async () => {
      const pr = await c.request('github.prStatus', { cwd: clone })
      console.log(`      → prStatus: ${pr === null ? 'null' : JSON.stringify(pr).slice(0, 120)}`)
    })
    await step('github.prDiff on an open PR', async () => {
      const prs = await c.request<{ number: number }[]>('github.workItems', { cwd: clone, kind: 'pr', assignedToMe: false, state: 'open', search: '', limit: 1 })
      if (!prs.length) return
      const diff = await c.request<{ files: unknown[]; additions: number; deletions: number; patch: string; truncated: boolean }>('github.prDiff', { cwd: clone, number: prs[0].number })
      assert.ok(Array.isArray(diff.files)); assert.equal(typeof diff.truncated, 'boolean')
      console.log(`      → PR #${prs[0].number}: ${diff.files.length} files, +${diff.additions} −${diff.deletions}, truncated=${diff.truncated}`)
    })
    console.log('SKIP  github.comment / github.createPr write to GitHub; covered by unit tests only')
  }
} finally {
  await client?.close().catch(() => undefined)
  await server?.close()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
