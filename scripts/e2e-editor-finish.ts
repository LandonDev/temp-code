/**
 * M14 exit test (docs/PLAN-3.md), headless slice: project.show serves the
 * diff surface's left side (HEAD content; null for untracked), and
 * fim.complete returns a plausible ghost-text insertion through the
 * user's existing Claude auth (or null — never an error). The visual
 * pieces (diff editing, ⌘T, format-on-save toggle) are the manual pass.
 * Run: bun run script:e2e-editor-finish
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../src/main/server'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

const server = await startServer(join(mkdtempSync(join(tmpdir(), 'tc-fin-db-')), 'fin.db'))
const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
await new Promise((r) => ws.on('open', r))
let nextId = 1
const pending = new Map<string, (v: { ok: boolean; result?: unknown; error?: string }) => void>()
ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.id && pending.has(frame.id)) {
    pending.get(frame.id)!(frame)
    pending.delete(frame.id)
  }
})
const request = <T>(method: string, params?: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = String(nextId++)
    pending.set(id, (f) => (f.ok ? resolve(f.result as T) : reject(new Error(f.error))))
    ws.send(JSON.stringify({ id, method, params }))
  })

// ── fixture repo: one committed file, then edit + one untracked ──────
const repo = mkdtempSync(join(tmpdir(), 'tc-fin-repo-'))
git(repo, 'init', '-b', 'main')
git(repo, 'config', 'user.email', 'e2e@temp-code.local')
git(repo, 'config', 'user.name', 'e2e')
writeFileSync(join(repo, 'main.ts'), 'export const version = 1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'v1')
writeFileSync(join(repo, 'main.ts'), 'export const version = 2\n')
writeFileSync(join(repo, 'fresh.ts'), 'export const brandNew = true\n')

const wsMeta = await request<{ id: string }>('workspace.create', { path: repo, name: 'fin' })
const project = await request<{ id: string }>('project.create', {
  workspaceId: wsMeta.id,
  name: 'Finish',
  mode: 'local'
})

// ── project.show: the diff surface's left side ───────────────────────
const head = await request<string | null>('project.show', {
  projectId: project.id,
  path: 'main.ts'
})
check('show: HEAD content, not the working tree', head === 'export const version = 1\n', head ?? 'null')
const untracked = await request<string | null>('project.show', {
  projectId: project.id,
  path: 'fresh.ts'
})
check('show: untracked file → null (diff against empty)', untracked === null)

// ── fim.complete: ghost text through the Agent SDK ───────────────────
const completion = await request<string | null>('fim.complete', {
  projectId: project.id,
  path: 'main.ts',
  prefix: 'function add(a: number, b: number): number {\n  return ',
  suffix: '\n}\n'
})
check(
  'fim: returns an insertion (or an honest null)',
  completion === null || (typeof completion === 'string' && completion.length > 0),
  JSON.stringify(completion)
)
if (typeof completion === 'string') {
  check('fim: completion mentions the operands', /a\s*\+\s*b/.test(completion), completion)
  const again = await request<string | null>('fim.complete', {
    projectId: project.id,
    path: 'main.ts',
    prefix: 'function add(a: number, b: number): number {\n  return ',
    suffix: '\n}\n'
  })
  check('fim: identical context hits the cache', again === completion)
}

ws.close()
await server.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
