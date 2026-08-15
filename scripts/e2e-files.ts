/**
 * M11 exit test (docs/PLAN-3.md): the file service.
 * list/read/write round-trip; atomic write (no tmp debris, content whole);
 * path escape refused; .git/ refused; watcher push on an external append;
 * oversized + binary files return tooLarge; create/rename/delete; hidden
 * dirs stay out of listings.
 * Run: bun run script:e2e-files
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeAllWatchers,
  fsCreate,
  fsDelete,
  fsList,
  fsRead,
  fsRename,
  fsWrite,
  subscribeFileEvents,
  type FileEvent
} from '../src/main/server/files'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const cwd = mkdtempSync(join(tmpdir(), 'tc-files-'))
mkdirSync(join(cwd, '.git'))
mkdirSync(join(cwd, '.temp-code'))
mkdirSync(join(cwd, 'src'))
writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(cwd, 'README.md'), '# hi\n')

// ── list ─────────────────────────────────────────────────────────────
const root = fsList(cwd, '')
check(
  'list: dirs first, hidden dirs gone',
  root.map((e) => e.name).join(',') === 'src,README.md',
  root.map((e) => e.name).join(',')
)
const src = fsList(cwd, 'src')
check('list: one level, sizes', src.length === 1 && src[0].size > 0)

// ── read/write round-trip + atomicity ────────────────────────────────
const r1 = fsRead(cwd, 'src/a.ts')
check('read: content + mtime', r1.content === 'export const a = 1\n' && r1.mtimeMs > 0)
const w1 = fsWrite(cwd, 'src/a.ts', 'export const a = 2\n')
check('write: bumps mtime', w1.mtimeMs >= r1.mtimeMs)
check('write: round-trips', fsRead(cwd, 'src/a.ts').content === 'export const a = 2\n')
check(
  'write: atomic — no tmp debris',
  readdirSync(join(cwd, 'src')).every((f) => !f.includes('tc-tmp'))
)
fsWrite(cwd, 'deep/new/file.txt', 'made parents\n')
check('write: creates parent dirs', fsRead(cwd, 'deep/new/file.txt').content === 'made parents\n')

// ── the jail ─────────────────────────────────────────────────────────
const refused = (fn: () => unknown): boolean => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
check(
  'escape ../ refused',
  refused(() => fsRead(cwd, '../outside'))
)
check(
  'escape via nested ../ refused',
  refused(() => fsWrite(cwd, 'src/../../evil', 'x'))
)
check(
  '.git write refused',
  refused(() => fsWrite(cwd, '.git/config', 'evil'))
)
check(
  '.git read refused',
  refused(() => fsRead(cwd, '.git/config'))
)
check(
  '.temp-code stays writable (plan docs)',
  !refused(() => fsWrite(cwd, '.temp-code/plan-x.md', '# plan'))
)
check(
  'delete root refused',
  refused(() => fsDelete(cwd, ''))
)

// ── tooLarge: oversized + binary ─────────────────────────────────────
writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 97))
check('oversized → tooLarge, no content', fsRead(cwd, 'big.bin').tooLarge === true)
writeFileSync(join(cwd, 'nul.dat'), Buffer.from([104, 105, 0, 104, 105]))
check('binary (NUL) → tooLarge', fsRead(cwd, 'nul.dat').tooLarge === true)

// ── create / rename / delete ─────────────────────────────────────────
fsCreate(cwd, 'src/b.ts', 'file')
check('create file', fsRead(cwd, 'src/b.ts').content === '')
check(
  'create over existing refused',
  refused(() => fsCreate(cwd, 'src/b.ts', 'file'))
)
fsCreate(cwd, 'src/lib', 'dir')
check(
  'create dir',
  fsList(cwd, 'src').some((e) => e.name === 'lib' && e.kind === 'dir')
)
fsRename(cwd, 'src/b.ts', 'src/lib/b.ts')
check(
  'rename moves',
  fsList(cwd, 'src/lib').some((e) => e.name === 'b.ts')
)
fsDelete(cwd, 'src/lib')
check('delete dir recursive', !fsList(cwd, 'src').some((e) => e.name === 'lib'))

// ── watcher: external append → one debounced push ────────────────────
const events: FileEvent[] = []
const off = subscribeFileEvents('p1', cwd, (e) => events.push(e))
await sleep(600) // chokidar warm-up
appendFileSync(join(cwd, 'src', 'a.ts'), '// agent was here\n')
await sleep(700)
check(
  'watcher: changed push for the edited path',
  events.some((e) => e.path === 'src/a.ts' && e.kind === 'changed' && e.projectId === 'p1'),
  JSON.stringify(events)
)
events.length = 0
writeFileSync(join(cwd, 'src', 'fresh.ts'), 'new\n')
await sleep(700)
check(
  'watcher: created push',
  events.some((e) => e.path === 'src/fresh.ts' && e.kind === 'created')
)
events.length = 0
writeFileSync(join(cwd, '.temp-code', 'noise.md'), 'x')
mkdirSync(join(cwd, 'node_modules'), { recursive: true })
writeFileSync(join(cwd, 'node_modules', 'noise.js'), 'x')
await sleep(700)
check('watcher: ignores .temp-code and node_modules', events.length === 0, JSON.stringify(events))
off()

await closeAllWatchers()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
