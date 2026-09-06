/**
 * Branch rail + Build rail exit test. Scratch repos, no UI:
 * compare counts/files; mergeFrom by rebase and merge (fast-forward, real
 * merge, conflict → aborted with the file list and a clean tree);
 * mergeInto a target held by the main checkout (clean → merged there;
 * dirty → refused, untouched) and one no checkout holds (fast-forward
 * via update-ref, merge-tree commit, conflict leaves both refs alone);
 * BuildRunner with glob outputs, log-scan outputs, stale outputs, cancel;
 * detectBuild on the real CosmicPrisons-Shredded checkout; effectiveBuild
 * precedence. Run: bun run script:e2e-branch-build
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { commit, compare, isClean, mergeFrom, mergeInto } from '../src/main/server/git'
import {
  BuildRunner,
  buildTargets,
  detectBuild,
  pullBranch,
  remoteStatus,
  resolveBuildDir
} from '../src/main/server/build'
import type { BuildRun } from '../src/shared/build'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
const write = (dir: string, name: string, text: string): void =>
  writeFileSync(join(dir, name), text)
const commitAll = async (dir: string, msg: string): Promise<string> => (await commit(dir, msg)).sha
const real = (p: string): string => realpathSync(p)

// ── scratch repo + bare origin ───────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'tc-branch-repo-'))
git(repo, 'init', '-b', 'main')
git(repo, 'config', 'user.email', 'e2e@temp-code.local')
git(repo, 'config', 'user.name', 'e2e')
write(repo, 'one.txt', 'first\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'first')
const firstSha = git(repo, 'rev-parse', 'HEAD')
write(repo, 'two.txt', 'second\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'second')
const origin = mkdtempSync(join(tmpdir(), 'tc-branch-origin-'))
execFileSync('git', ['init', '--bare', origin])
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', 'origin', 'main')

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-branch-db-')), 'b.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
const ws = await registry.createWorkspace(repo, 'branch-ws')
const project = await registry.createProject(ws.id, 'Flow', 'worktree')
const cleanup: string[] = [project.cwd]

// ── compare ──────────────────────────────────────────────────────────
let cmp = await compare(project.cwd)
check('default target is main (held by the checkout)', cmp.target === 'main', cmp.target)
check('fresh branch: 0 ahead 0 behind', cmp.ahead === 0 && cmp.behind === 0)
write(project.cwd, 'feat.txt', 'feature\n')
await commitAll(project.cwd, 'feat')
write(repo, 'main.txt', 'main work\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'main work')
cmp = await compare(project.cwd, 'main')
check('diverged: 1 ahead 1 behind', cmp.ahead === 1 && cmp.behind === 1, `${cmp.ahead}/${cmp.behind}`)
check(
  'files vs merge base: feat.txt added',
  cmp.files.length === 1 && cmp.files[0].path === 'feat.txt' && cmp.files[0].status === 'added',
  JSON.stringify(cmp.files)
)
check('ours/theirs subjects', cmp.ours[0]?.subject === 'feat' && cmp.theirs[0]?.subject === 'main work')
check('merge base is the fork point', cmp.mergeBase === git(repo, 'rev-parse', 'HEAD~1'))
await compare(project.cwd, 'nope').then(
  () => check('unknown target throws', false),
  (err) => check('unknown target throws', String(err).includes('unknown branch'), String(err))
)

// ── mergeFrom: rebase ────────────────────────────────────────────────
const rb = await mergeFrom(project.cwd, 'main', 'rebase')
check('rebase ok', rb.ok, JSON.stringify(rb))
cmp = await compare(project.cwd, 'main')
check('after rebase: 1 ahead 0 behind, linear', cmp.ahead === 1 && cmp.behind === 0)
check('rebased commit sits on main', git(project.cwd, 'rev-parse', 'HEAD~1') === git(repo, 'rev-parse', 'main'))

// ── mergeFrom: real merge, then fast-forward ─────────────────────────
write(repo, 'main2.txt', 'more main\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'main 2')
const mg = await mergeFrom(project.cwd, 'main', 'merge')
check('merge ok, not a fast-forward', mg.ok && !mg.fastForward, JSON.stringify(mg))
check('merge commit has two parents', git(project.cwd, 'rev-parse', 'HEAD^2').length === 40)
check('main2.txt landed in the checkout', existsSync(join(project.cwd, 'main2.txt')))

const ff = await registry.createProject(ws.id, 'FF', 'worktree')
cleanup.push(ff.cwd)
write(repo, 'main3.txt', 'ff me\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'main 3')
const ffr = await mergeFrom(ff.cwd, 'main', 'merge')
check('fast-forward merge reported', ffr.ok && ffr.fastForward, JSON.stringify(ffr))
check('ff checkout at main tip', git(ff.cwd, 'rev-parse', 'HEAD') === git(repo, 'rev-parse', 'main'))

// ── dirty tree refuses ───────────────────────────────────────────────
write(project.cwd, 'feat.txt', 'edited, uncommitted\n')
await mergeFrom(project.cwd, 'main', 'merge').then(
  () => check('dirty tree refuses update', false),
  (err) => check('dirty tree refuses update', String(err).includes('Commit or stash'), String(err))
)
git(project.cwd, 'checkout', '--', 'feat.txt')

// ── conflicts abort (merge + rebase) ─────────────────────────────────
write(repo, 'one.txt', 'main version\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'main edits one')
write(project.cwd, 'one.txt', 'branch version\n')
const beforeConflict = await commitAll(project.cwd, 'branch edits one')
const cm = await mergeFrom(project.cwd, 'main', 'merge')
check(
  'merge conflict → aborted with file list',
  !cm.ok && cm.conflicts.length === 1 && cm.conflicts[0] === 'one.txt',
  JSON.stringify(cm)
)
check('tree clean after aborted merge', await isClean(project.cwd))
check('HEAD unchanged after aborted merge', git(project.cwd, 'rev-parse', 'HEAD') === beforeConflict)
check('no MERGE_HEAD left', !existsSync(git(project.cwd, 'rev-parse', '--git-path', 'MERGE_HEAD')))
const cr = await mergeFrom(project.cwd, 'main', 'rebase')
check(
  'rebase conflict → aborted with file list',
  !cr.ok && cr.conflicts.includes('one.txt'),
  JSON.stringify(cr)
)
check('HEAD unchanged after aborted rebase', git(project.cwd, 'rev-parse', 'HEAD') === beforeConflict)
check(
  'no rebase in progress',
  !existsSync(git(project.cwd, 'rev-parse', '--git-path', 'rebase-merge')) &&
    !existsSync(git(project.cwd, 'rev-parse', '--git-path', 'rebase-apply'))
)

// ── mergeInto: target checked out in the main checkout ───────────────
write(ff.cwd, 'land.txt', 'land me\n')
await commitAll(ff.cwd, 'land')
const mainBefore = git(repo, 'rev-parse', 'main')
const li = await mergeInto(ff.cwd, 'main')
check(
  'mergeInto checked-out main: ok, names the checkout',
  li.ok && !!li.where && real(li.where) === real(repo),
  JSON.stringify(li)
)
check('main advanced', git(repo, 'rev-parse', 'main') !== mainBefore)
check('main checkout working tree has land.txt', existsSync(join(repo, 'land.txt')))
check(
  'main had moved on → a merge commit there',
  li.ok && !li.fastForward && git(repo, 'rev-parse', 'main^2') === git(ff.cwd, 'rev-parse', 'HEAD~0'),
  git(repo, 'log', '--oneline', '-1')
)

write(repo, 'two.txt', 'dirty edit\n') // tracked, uncommitted
write(ff.cwd, 'land2.txt', 'second landing\n')
await commitAll(ff.cwd, 'land 2')
const mainDirtyBefore = git(repo, 'rev-parse', 'main')
await mergeInto(ff.cwd, 'main').then(
  () => check('dirty target checkout refuses', false),
  (err) =>
    check('dirty target checkout refuses', String(err).includes('uncommitted changes'), String(err))
)
check('main untouched by the refusal', git(repo, 'rev-parse', 'main') === mainDirtyBefore)
git(repo, 'checkout', '--', 'two.txt')

// ── mergeInto: target no checkout holds ──────────────────────────────
git(repo, 'branch', 'release', git(ff.cwd, 'rev-parse', 'HEAD~1')) // an ancestor of ff HEAD
const repoSnap = (): string => `${git(repo, 'rev-parse', 'HEAD')}|${git(repo, 'status', '--porcelain')}`
const snap = repoSnap()
const ffRel = await mergeInto(ff.cwd, 'release')
check('unheld target, ancestor → fast-forward via update-ref', ffRel.ok && ffRel.fastForward, JSON.stringify(ffRel))
check('release now at ff HEAD', git(repo, 'rev-parse', 'release') === git(ff.cwd, 'rev-parse', 'HEAD'))
check('main checkout untouched', repoSnap() === snap)

// A branch with its own commit, made in a throwaway worktree then unheld.
git(repo, 'branch', 'release2', 'main')
const tmpWt = mkdtempSync(join(tmpdir(), 'tc-branch-wt-'))
git(repo, 'worktree', 'add', tmpWt, 'release2')
write(tmpWt, 'rel.txt', 'release only\n')
git(tmpWt, 'add', '-A')
git(tmpWt, 'commit', '-m', 'release-only change')
git(repo, 'worktree', 'remove', '--force', tmpWt)
const rel2Before = git(repo, 'rev-parse', 'release2')
const mt = await mergeInto(ff.cwd, 'release2')
check('unheld diverged target → merge-tree commit', mt.ok && !mt.fastForward, JSON.stringify(mt))
const rel2 = git(repo, 'rev-parse', 'release2')
check(
  'release2 is a merge of both tips',
  git(repo, 'rev-parse', `${rel2}^1`) === rel2Before &&
    git(repo, 'rev-parse', `${rel2}^2`) === git(ff.cwd, 'rev-parse', 'HEAD')
)
check('merged tree has both sides', git(repo, 'cat-file', '-p', 'release2:rel.txt') === 'release only' && git(repo, 'cat-file', '-p', 'release2:land2.txt') === 'second landing')
check('main checkout still untouched', repoSnap() === snap)

// Conflict path: add/add on land.txt from an older fork.
git(repo, 'branch', 'release3', firstSha)
const tmpWt3 = mkdtempSync(join(tmpdir(), 'tc-branch-wt3-'))
git(repo, 'worktree', 'add', tmpWt3, 'release3')
write(tmpWt3, 'land.txt', 'a different landing\n')
git(tmpWt3, 'add', '-A')
git(tmpWt3, 'commit', '-m', 'conflicting land')
git(repo, 'worktree', 'remove', '--force', tmpWt3)
const rel3Before = git(repo, 'rev-parse', 'release3')
const ffHeadBefore = git(ff.cwd, 'rev-parse', 'HEAD')
const mtc = await mergeInto(ff.cwd, 'release3')
check('merge-tree conflict → files listed', !mtc.ok && mtc.conflicts.includes('land.txt'), JSON.stringify(mtc))
check('release3 untouched', git(repo, 'rev-parse', 'release3') === rel3Before)
check('source untouched', git(ff.cwd, 'rev-parse', 'HEAD') === ffHeadBefore)
await mergeInto(ff.cwd, 'origin/main').then(
  () => check('remote target refused', false),
  (err) => check('remote target refused', String(err).includes('not a local branch'), String(err))
)

// ── BuildRunner ──────────────────────────────────────────────────────
const runner = new BuildRunner()
const done = (projectId: string): Promise<{ run: BuildRun; lines: string[] }> =>
  new Promise((resolve) => {
    const lines: string[] = []
    const off = runner.onPush((p) => {
      if (p.projectId !== projectId) return
      lines.push(...(p.lines ?? []))
      if (p.run.status !== 'running') {
        off()
        resolve({ run: p.run, lines })
      }
    })
  })

const bdir = mkdtempSync(join(tmpdir(), 'tc-build-'))
mkdirSync(join(bdir, 'out'))
write(bdir, 'out/old.jar', 'stale')
const hourAgo = new Date(Date.now() - 3600_000)
utimesSync(join(bdir, 'out/old.jar'), hourAgo, hourAgo)

let waiting = done('b1')
await runner.run('b1', bdir, {
  command: 'echo building && printf "\\033[32mgreen\\033[0m\\n" && touch out/a.jar',
  outputs: 'out/*.jar,!out/old.jar',
  source: 'detected'
})
let r = await waiting
check('glob build ok', r.run.status === 'ok' && r.run.exitCode === 0, JSON.stringify(r.run))
check('log streamed, ANSI stripped', r.lines.includes('building') && r.lines.includes('green'), JSON.stringify(r.lines))
check(
  'one fresh output, negation honored',
  r.run.outputs.length === 1 && r.run.outputs[0].path === 'out/a.jar' && r.run.outputs[0].fresh,
  JSON.stringify(r.run.outputs)
)
const st = runner.status('b1')
check('status replays run + lines', st.run?.id === r.run.id && st.lines.length === r.lines.length)

waiting = done('b1')
await runner.run('b1', bdir, { command: 'echo nothing to do', outputs: 'out/old.jar', source: 'workspace' })
r = await waiting
check('stale match reported as not fresh', r.run.outputs.length === 1 && !r.run.outputs[0].fresh, JSON.stringify(r.run.outputs))

waiting = done('b2')
await runner.run('b2', bdir, {
  command: 'mkdir -p dist && touch dist/b.zip && echo "wrote dist/b.zip and missing/c.jar"',
  outputs: '',
  source: 'detected'
})
r = await waiting
check(
  'no glob → log scan finds the existing artifact only',
  r.run.outputs.length === 1 && r.run.outputs[0].path === 'dist/b.zip',
  JSON.stringify(r.run.outputs)
)

waiting = done('b3')
await runner.run('b3', bdir, { command: 'exit 3', outputs: '', source: 'detected' })
r = await waiting
check('failure carries the exit code', r.run.status === 'failed' && r.run.exitCode === 3)

waiting = done('b4')
await runner.run('b4', bdir, { command: 'sleep 30', outputs: '', source: 'detected' })
await runner.run('b4', bdir, { command: 'echo', outputs: '', source: 'detected' }).then(
  () => check('second run while running refused', false),
  (err) => check('second run while running refused', String(err).includes('already running'))
)
const t0 = Date.now()
runner.cancel('b4')
r = await waiting
check('cancel → cancelled quickly', r.run.status === 'cancelled' && Date.now() - t0 < 6000, `${Date.now() - t0}ms`)

// ── detection + precedence ───────────────────────────────────────────
const cosmic = join(homedir(), 'IdeaProjects', 'CosmicPrisons-Shredded')
if (existsSync(cosmic)) {
  const det = await detectBuild(cosmic)
  check(
    'CosmicPrisons-Shredded detects Maven',
    !!det && /mvnw? -B -DskipTests package$/.test(det.command) && det.outputs.startsWith('target/*.jar'),
    JSON.stringify(det)
  )
} else console.log('SKIP  CosmicPrisons-Shredded not present')
check('non-build dir detects nothing', (await detectBuild(bdir)) === null)
write(project.cwd, 'package.json', JSON.stringify({ scripts: { build: 'tsc' } }))
let eff = await registry.effectiveBuild(project.id)
check('detected bun run build', eff?.source === 'detected' && eff.command === 'bun run build', JSON.stringify(eff))
registry.setBuild(ws.id, { command: 'make', outputs: 'bin/*' })
eff = await registry.effectiveBuild(project.id)
check('workspace setting beats detection', eff?.source === 'workspace' && eff.command === 'make')
registry.setProjectBuild(project.id, { command: 'make fast', outputs: '' })
eff = await registry.effectiveBuild(project.id)
check('project override beats workspace', eff?.source === 'project' && eff.command === 'make fast')
registry.setProjectBuild(project.id, null)
registry.setBuild(ws.id, null)
eff = await registry.effectiveBuild(project.id)
check('cleared → back to detection', eff?.source === 'detected')

// ── build targets: build another branch without switching the project ──
const targets = await buildTargets(project)
check(
  'targets: own branch first, main as a checkout, unheld branches without a dir',
  targets[0]?.branch === project.branch &&
    targets[0]?.cwd === project.cwd &&
    targets.some((t) => t.branch === 'main' && t.cwd && real(t.cwd) === real(repo) && t.kind === 'checkout') &&
    targets.some((t) => t.branch === 'release2' && t.cwd === null && t.kind === 'branch'),
  JSON.stringify(targets)
)
const ownDir = await resolveBuildDir(project, undefined)
check('no branch → the project checkout', ownDir.cwd === project.cwd && ownDir.branch === project.branch)
const mainDir = await resolveBuildDir(project, 'main')
check('held branch → its checkout', real(mainDir.cwd) === real(repo) && mainDir.branch === 'main')
const rel2Dir = await resolveBuildDir(project, 'release2')
cleanup.push(rel2Dir.cwd)
check(
  'unheld branch → detached build worktree at its tip',
  rel2Dir.cwd.includes('/.temp-code/builds/') &&
    git(rel2Dir.cwd, 'rev-parse', 'HEAD') === git(repo, 'rev-parse', 'release2') &&
    git(rel2Dir.cwd, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD' &&
    existsSync(join(rel2Dir.cwd, 'rel.txt')),
  rel2Dir.cwd
)
check('release2 still not held by any checkout', !(await buildTargets(project)).some((t) => t.branch === 'release2' && t.cwd))
const again = await resolveBuildDir(project, 'release2')
check('second resolve reuses the build worktree', again.cwd === rel2Dir.cwd)
await resolveBuildDir(project, 'nope').then(
  () => check('unknown branch refused', false),
  (err) => check('unknown branch refused', String(err).includes('not a local branch'), String(err))
)
waiting = done('b5')
await runner.run(
  'b5',
  rel2Dir.cwd,
  { command: 'echo building release2 && touch here.jar', outputs: '*.jar', source: 'detected' },
  'release2'
)
r = await waiting
check(
  'build in the build worktree: outputs live there, run names the branch',
  r.run.status === 'ok' &&
    r.run.branch === 'release2' &&
    r.run.cwd === rel2Dir.cwd &&
    r.run.outputs[0]?.abs === join(rel2Dir.cwd, 'here.jar'),
  JSON.stringify(r.run)
)
check('project checkout untouched by the other build', !existsSync(join(project.cwd, 'here.jar')))

// ── origin sync for a build branch ───────────────────────────────────
const clone2 = mkdtempSync(join(tmpdir(), 'tc-branch-clone-'))
execFileSync('git', ['clone', '-q', origin, clone2])
git(clone2, 'config', 'user.email', 'e2e@temp-code.local')
git(clone2, 'config', 'user.name', 'e2e')
git(clone2, 'checkout', '-q', '-b', 'sync')
write(clone2, 's1.txt', 'one\n')
git(clone2, 'add', '-A')
git(clone2, 'commit', '-q', '-m', 's1')
git(clone2, 'push', '-q', 'origin', 'sync')
git(repo, 'fetch', '-q', 'origin')
git(repo, 'branch', 'sync', 'origin/sync') // local, unheld, current
let rs = await remoteStatus(project, 'sync')
check('unheld branch current with origin', rs?.upstream && rs.ahead === 0 && rs.behind === 0 && rs.stale === false, JSON.stringify(rs))
rs = await remoteStatus(project, 'main')
check('main: unpushed commits show as ahead, not stale', rs?.upstream && rs.ahead > 0 && rs.behind === 0 && rs.stale === false, JSON.stringify(rs))
check('branch without origin', (await remoteStatus(project, 'release'))?.upstream === false)
write(clone2, 's2.txt', 'two\n')
git(clone2, 'add', '-A')
git(clone2, 'commit', '-q', '-m', 's2')
git(clone2, 'push', '-q', 'origin', 'sync')
rs = await remoteStatus(project, 'sync')
check('origin moved → stale, counts still from the last fetch', rs?.stale === true && rs.behind === 0, JSON.stringify(rs))
const progress: string[] = []
rs = await pullBranch(project, 'sync', (p) => progress.push(p.line))
check(
  'pull unheld: ref fast-forwarded, progress streamed, now current',
  git(repo, 'rev-parse', 'sync') === git(clone2, 'rev-parse', 'HEAD') && progress.length > 0 && rs?.stale === false && rs.behind === 0,
  `${progress.length} lines · ${JSON.stringify(rs)}`
)
git(ff.cwd, 'checkout', '-q', 'sync') // now a checkout holds it
write(clone2, 's3.txt', 'three\n')
git(clone2, 'add', '-A')
git(clone2, 'commit', '-q', '-m', 's3')
git(clone2, 'push', '-q', 'origin', 'sync')
git(repo, 'fetch', '-q', 'origin', 'sync')
rs = await remoteStatus(project, 'sync')
check('fetched but not merged → behind 1', rs?.behind === 1 && rs.stale === false, JSON.stringify(rs))
rs = await pullBranch(project, 'sync', () => {})
check(
  'pull held: checkout fast-forwarded with its working tree',
  git(ff.cwd, 'rev-parse', 'HEAD') === git(clone2, 'rev-parse', 'HEAD') && existsSync(join(ff.cwd, 's3.txt')) && rs?.behind === 0
)
write(ff.cwd, 'local.txt', 'mine\n')
await commitAll(ff.cwd, 'local only')
write(clone2, 's4.txt', 'four\n')
git(clone2, 'add', '-A')
git(clone2, 'commit', '-q', '-m', 's4')
git(clone2, 'push', '-q', 'origin', 'sync')
const localTip = git(ff.cwd, 'rev-parse', 'HEAD')
await pullBranch(project, 'sync', () => {}).then(
  () => check('diverged pull refused', false),
  (err) => check('diverged pull refused, says why', String(err).includes('1 local commit'), String(err))
)
check('diverged: local untouched, origin fetched', git(ff.cwd, 'rev-parse', 'HEAD') === localTip && (await remoteStatus(project, 'sync'))?.behind === 1)

for (const dir of cleanup) git(repo, 'worktree', 'remove', '--force', dir)
await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
