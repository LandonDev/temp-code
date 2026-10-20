/**
 * The R2 security fixes end to end (docs/reviews/2026-10-20-r2-security.md),
 * against a real server on a temp database with the fixed-port listener on
 * an ephemeral port and no model turn, so the release gate can run it:
 *   H1/H2  a read key and an operate key are refused on every fs.*, git.*,
 *          github.* and search.project call that names a path outside the
 *          app-managed roots, and succeed on the same calls inside a
 *          workspace; a symlink pointing out is refused; the desktop's own
 *          loopback socket is not fenced; the work root admits a new
 *          workspace, the bare home directory does not.
 *   M1     three concurrent redeems of one pairing code mint one key.
 *   M3     a webhook key aimed at 127.0.0.1, 169.254.169.254 or 10/8 is
 *          refused when the key is made.
 *   L1     a spoofed Host on an anonymous loopback request does not move
 *          the pairing link; an admin's request does.
 *   L2     the anonymous hello carries no hostname or version.
 *   L3     the /pair page allows its script by nonce only.
 * Run: bun run script:e2e-remote-fence
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import { startServer } from '../src/main/server/index'
import type { ServerFrame } from '../src/shared/contract'

const root = mkdtempSync(join(tmpdir(), 'tc-fence-'))
configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0 })
const base = `http://127.0.0.1:${server.remote!.port}`

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** node:http rather than fetch: fetch drops a caller's Host header, and a chosen Host is part of what is under test. */
function api(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = init.body !== undefined ? JSON.stringify(init.body) : undefined
    const req = httpRequest(
      base + path,
      { method, headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...init.headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: text })
          }
        })
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

interface Socket {
  ws: WebSocket
  request: (method: string, params?: unknown) => Promise<{ ok: boolean; result?: any; error?: string }>
}
function open(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let next = 1
    const pending = new Map<string, (frame: any) => void>()
    ws.on('message', (d) => {
      const frame = JSON.parse(String(d)) as ServerFrame & { id?: string }
      if (frame.id) pending.get(frame.id)?.(frame)
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        ws,
        request: (method, params = {}) =>
          new Promise((r) => {
            const id = String(next++)
            pending.set(id, r)
            ws.send(JSON.stringify({ id, method, params }))
          })
      })
    )
  })
}
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })
const socketFor = async (token: string): Promise<Socket> => {
  const ticket = await api('POST', '/api/ticket', { headers: bearer(token) })
  return open(`${base.replace('http', 'ws')}/ws?ticket=${ticket.body.ticket}`)
}

// ── the roots: one workspace (a git repo), one directory outside everything ──
const workspace = mkdtempSync(join(tmpdir(), 'tc-fence-ws-'))
const outside = mkdtempSync(join(tmpdir(), 'tc-fence-out-'))
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=fence', '-c', 'user.email=fence@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'main')
mkdirSync(join(workspace, 'src'))
writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(workspace, 'README.md'), 'inside\n')
git('add', '.')
git('commit', '-q', '-m', 'first')
writeFileSync(join(outside, 'secret.txt'), 'secret\n')
mkdirSync(join(outside, 'dir'))
symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link-out'))
await server.registry.createWorkspace(workspace, 'fenced')

const admin = (await server.remoteAuth.createKey({ name: 'desk', audience: 'client', caps: ['admin'], createdBy: 'local' })).token
const readKey = (await server.remoteAuth.createKey({ name: 'reader', audience: 'client', caps: [], createdBy: 'local' })).token
const operateKey = (await server.remoteAuth.createKey({ name: 'operator', audience: 'client', caps: ['operate'], createdBy: 'local' })).token
const reader = await socketFor(readKey)
const operator = await socketFor(operateKey)
const refused = (method: string): string => `forbidden: ${method} is outside app-managed roots`

// ── H1/H2: every path-taking method, outside and inside ───────────────────
type Case = { method: string; outside: unknown; inside: unknown; insideOk?: boolean }
const inside = (p: string): string => join(workspace, p)
const out = (p: string): string => join(outside, p)
const reads: Case[] = [
  { method: 'fs.listPath', outside: { path: outside }, inside: { path: workspace }, insideOk: true },
  { method: 'fs.projectFiles', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'fs.readPreview', outside: { path: out('secret.txt'), maxLines: 20 }, inside: { path: inside('README.md'), maxLines: 20 }, insideOk: true },
  { method: 'fs.readText', outside: { path: out('secret.txt') }, inside: { path: inside('README.md') }, insideOk: true },
  { method: 'fs.readBase64', outside: { path: out('secret.txt') }, inside: { path: inside('README.md') }, insideOk: true },
  { method: 'fs.statFiles', outside: { paths: [inside('README.md'), out('secret.txt')] }, inside: { paths: [inside('README.md')] }, insideOk: true },
  { method: 'fs.inspectPaths', outside: { paths: [out('secret.txt')] }, inside: { paths: [inside('README.md')] }, insideOk: true },
  { method: 'search.project', outside: { options: { cwd: outside, query: 'secret' } }, inside: { options: { cwd: workspace, query: 'inside' } }, insideOk: true },
  { method: 'git.log', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'git.branches', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'git.diffStats', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'git.diffIndex', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'git.stagedContext', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'git.rangeContext', outside: { cwd: outside }, inside: { cwd: workspace } },
  { method: 'git.fileDiff', outside: { cwd: outside, relative: 'secret.txt' }, inside: { cwd: workspace, relative: 'README.md' } },
  { method: 'git.fileMedia', outside: { cwd: outside, relative: 'secret.txt' }, inside: { cwd: workspace, relative: 'README.md' } },
  { method: 'github.details', outside: { cwd: outside, kind: 'pr', number: 1 }, inside: { cwd: workspace, kind: 'pr', number: 1 } },
  { method: 'github.thread', outside: { cwd: outside, kind: 'pr', number: 1 }, inside: { cwd: workspace, kind: 'pr', number: 1 } },
  { method: 'github.prDiff', outside: { cwd: outside, number: 1 }, inside: { cwd: workspace, number: 1 } },
  { method: 'github.prStatus', outside: { cwd: outside }, inside: { cwd: workspace } },
  { method: 'build.detect', outside: { path: outside }, inside: { path: workspace }, insideOk: true },
  { method: 'commands.list', outside: { provider: 'claude', cwd: outside }, inside: { provider: 'claude', cwd: workspace }, insideOk: true }
]
const writes: Case[] = [
  { method: 'fs.writeText', outside: { path: out('new.txt'), content: 'x' }, inside: { path: inside('new.txt'), content: 'x' }, insideOk: true },
  { method: 'fs.createPath', outside: { parent: outside, name: 'made', isDir: true }, inside: { parent: workspace, name: 'made', isDir: true }, insideOk: true },
  { method: 'fs.renamePath', outside: { path: out('secret.txt'), name: 'moved.txt' }, inside: { path: inside('new.txt'), name: 'renamed.txt' }, insideOk: true },
  { method: 'fs.copyPath', outside: { from: inside('README.md'), destParent: outside }, inside: { from: inside('README.md'), destParent: inside('made') }, insideOk: true },
  { method: 'fs.movePath', outside: { from: inside('renamed.txt'), destParent: outside }, inside: { from: inside('renamed.txt'), destParent: inside('made') }, insideOk: true },
  { method: 'fs.deletePath', outside: { path: out('secret.txt') }, inside: { path: inside('made') }, insideOk: true },
  { method: 'git.stageAll', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'git.unstageAll', outside: { cwd: outside }, inside: { cwd: workspace }, insideOk: true },
  { method: 'git.stageFile', outside: { cwd: outside, relative: 'secret.txt' }, inside: { cwd: workspace, relative: 'README.md' }, insideOk: true },
  { method: 'git.unstageFile', outside: { cwd: outside, relative: 'secret.txt' }, inside: { cwd: workspace, relative: 'README.md' }, insideOk: true },
  { method: 'git.stageContents', outside: { cwd: outside, relative: 'secret.txt', contents: 'x' }, inside: { cwd: workspace, relative: 'README.md', contents: 'staged\n' }, insideOk: true },
  { method: 'git.commitStaged', outside: { cwd: outside, message: 'x' }, inside: { cwd: workspace, message: 'second' }, insideOk: true },
  { method: 'git.discardFile', outside: { cwd: outside, relative: 'secret.txt' }, inside: { cwd: workspace, relative: 'README.md' }, insideOk: true },
  { method: 'git.createBranch', outside: { cwd: outside, name: 'b' }, inside: { cwd: workspace, name: 'fence-branch' }, insideOk: true },
  { method: 'git.checkout', outside: { cwd: outside, name: 'main' }, inside: { cwd: workspace, name: 'main' }, insideOk: true },
  { method: 'git.stash', outside: { cwd: outside, message: 'x' }, inside: { cwd: workspace, message: 'x' } },
  { method: 'git.push', outside: { cwd: outside }, inside: { cwd: workspace } },
  { method: 'git.pull', outside: { cwd: outside }, inside: { cwd: workspace } },
  { method: 'git.sync', outside: { cwd: outside }, inside: { cwd: workspace } },
  { method: 'git.clone', outside: { url: 'https://example.invalid/r.git', parent: outside }, inside: { url: 'https://example.invalid/r.git', parent: workspace } },
  { method: 'github.comment', outside: { cwd: outside, kind: 'pr', number: 1, body: 'x' }, inside: { cwd: workspace, kind: 'pr', number: 1, body: 'x' } },
  { method: 'github.createPr', outside: { cwd: outside, title: 'x', body: 'x', base: 'main', head: 'b' }, inside: { cwd: workspace, title: 'x', body: 'x', base: 'main', head: 'fence-branch' } },
  { method: 'projectLogo.save', outside: { projectPath: workspace, sourcePath: out('secret.txt') }, inside: { projectPath: workspace, sourcePath: inside('README.md') } },
  { method: 'projectLogo.remove', outside: { projectPath: outside }, inside: { projectPath: workspace }, insideOk: true },
  { method: 'text.generate', outside: { prompt: 'x', cwd: outside }, inside: null },
  { method: 'session.create', outside: { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', threadType: 'chat', title: 'fenced', cwd: outside }, inside: null },
  { method: 'workspace.create', outside: { path: outside }, inside: null }
]
let fenced = 0
let insideFailures = 0
const run = async (socket: Socket, cases: Case[]): Promise<void> => {
  for (const c of cases) {
    const away = await socket.request(c.method, c.outside)
    if (away.error === refused(c.method)) fenced++
    else check(`${c.method} outside the roots is refused`, false, away.error ?? JSON.stringify(away.result).slice(0, 80))
    if (c.inside === null) continue
    const home = await socket.request(c.method, c.inside)
    const fine = c.insideOk ? home.ok === true : home.error !== refused(c.method)
    if (!fine) {
      insideFailures++
      check(`${c.method} inside the workspace ${c.insideOk ? 'succeeds' : 'is not fenced'}`, false, home.error)
    }
  }
}
await run(reader, reads)
await run(operator, reads)
check('a symlink inside the workspace that points out is refused', (await reader.request('fs.readText', { path: inside('link-out') })).error === refused('fs.readText'))
await run(operator, writes)
check(`every path-taking method is refused outside the roots for a read key and an operate key`, fenced === reads.length * 2 + writes.length, `${fenced} refusals of ${reads.length * 2 + writes.length} calls`)
check('the same calls inside the workspace succeed', insideFailures === 0)
check('the read key is stopped by the capability gate before the fence', (await reader.request('fs.writeText', { path: inside('x'), content: 'x' })).error === 'forbidden: fs.writeText needs operate')
check('nothing outside was touched', readFileSync(out('secret.txt'), 'utf8') === 'secret\n' && !existsSyncSafe(out('new.txt')) && !existsSyncSafe(out('made')) && !existsSyncSafe(out('README.md')))
check('the fence error names the method, never the path', !JSON.stringify((await reader.request('fs.readText', { path: out('secret.txt') })).error).includes(outside))
const local = await open(`ws://127.0.0.1:${server.port}/`)
check("the desktop's own loopback socket is not fenced", (await local.request('fs.readText', { path: out('secret.txt') })).result === 'secret\n')
// The work root admits a new workspace from a remote client (the folder dialog); the bare home directory never does.
const workRoot = mkdtempSync(join(tmpdir(), 'tc-fence-work-'))
mkdirSync(join(workRoot, 'new-repo'))
check('a workspace outside every root is refused until the work root is set', (await operator.request('workspace.create', { path: join(workRoot, 'new-repo') })).error === refused('workspace.create'))
server.store.setSetting('workspace.root', workRoot)
check('a workspace under the configured work root is accepted', (await operator.request('workspace.create', { path: join(workRoot, 'new-repo') })).ok === true)
check('the home directory is not a root even when it is the work root', (await reader.request('fs.listPath', { path: join(process.env.HOME ?? '~', '.ssh') })).error === refused('fs.listPath'))
function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

// ── M1: one code, three concurrent redeems, one key ────────────────────────
const pairing = await api('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'phone', audience: 'client', caps: ['operate'] } })
const keysBefore = (await api('GET', '/api/keys', { headers: bearer(admin) })).body.length
const redeems = await Promise.all(Array.from({ length: 3 }, () => api('POST', '/api/pair', { body: { code: pairing.body.code, kind: 'key' } })))
const keysAfter = (await api('GET', '/api/keys', { headers: bearer(admin) })).body.length
check('three concurrent redeems of one code mint one key', redeems.filter((r) => r.status === 200).length === 1 && redeems.filter((r) => r.status === 401).length === 2 && keysAfter === keysBefore + 1, `${redeems.map((r) => r.status).join(',')} keys ${keysBefore}→${keysAfter}`)

// ── M3: private, loopback and metadata webhook targets are refused when the key is made ──
for (const url of ['http://127.0.0.1:9/hook', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/hook', 'https://[fd00:ec2::254]/hook', 'https://metadata.google.internal/computeMetadata/v1/']) {
  const made = await api('POST', '/api/keys', { headers: bearer(admin), body: { name: 'bot', audience: 'mcp', caps: ['operate'], webhookUrl: url } })
  check(`a webhook at ${url} is refused at creation`, made.status === 400 && /private or local/.test(made.body.error), `${made.status} ${made.body.error ?? ''}`)
}

// ── L1: a spoofed Host on an anonymous loopback request does not move the pairing link ──
const linkBefore = (await api('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'x', audience: 'client', caps: [] } })).body.url
await api('GET', '/api/hello', { headers: { Host: 'evil.example', 'X-Forwarded-Proto': 'https' } })
await api('POST', '/api/pair', { body: { code: 'AAAAA-AAAAA', kind: 'key' }, headers: { Host: 'evil.example', 'X-Forwarded-Proto': 'https' } })
const linkAfter = (await api('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'x', audience: 'client', caps: [] } })).body.url
check('a spoofed Host on an anonymous request leaves the pairing link alone', new URL(linkAfter).origin === new URL(linkBefore).origin && linkAfter.startsWith('http://127.0.0.1:'), linkAfter)
await api('GET', '/api/keys', { headers: { ...bearer(admin), Host: 'tempcode.example.com', 'X-Forwarded-Proto': 'https' } })
const linkAdmin = (await api('POST', '/api/pairings', { headers: bearer(admin), body: { name: 'x', audience: 'client', caps: [] } })).body.url
check("an admin's own request teaches it", linkAdmin.startsWith('https://tempcode.example.com/pair#'), linkAdmin)

// ── L2: the anonymous hello carries no hostname or version ─────────────────
const anonymous = await api('GET', '/api/hello')
const known = await api('GET', '/api/hello', { headers: bearer(readKey) })
check('anonymous hello names only the environment and contract', anonymous.status === 200 && anonymous.body.environmentId === server.environmentId && anonymous.body.name === undefined && anonymous.body.version === undefined, JSON.stringify(anonymous.body))
check('hello with a key carries the hostname and version', typeof known.body.name === 'string' && typeof known.body.version === 'string')

// ── L3: the pair page allows its script by nonce only ──────────────────────
const page = await api('GET', '/pair')
const nonce = /script-src 'nonce-([^']+)'/.exec(String(page.body))?.[1]
check('the /pair page has a nonced script-src and no unsafe-inline for scripts', !!nonce && String(page.body).includes(`<script nonce="${nonce}">`) && !/script-src[^;]*unsafe-inline/.test(String(page.body)))

for (const s of [reader, operator, local]) s.ws.close()
await server.close()
for (const dir of [root, workspace, outside, workRoot]) rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
