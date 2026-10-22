/**
 * Cut a local release: `bun scripts/release.ts "one-line notes" [--full] [--push]`.
 *
 * Gates on a clean tree and the gate's `commit` tier (scripts/gate.ts:
 * typecheck, vitest and a real build, run at once), plus the `publish` tier
 * when a commit since the last release touched a path it guards (ios/**,
 * the Swift contract generator, wireSchemas.ts, the remote server, the hub:
 * TIER_PATHS in gate.ts). Then bumps release.json to N and package.json to
 * 1.0.N, commits both, and tags `release-N`. That is the whole of the local
 * train: nothing here reaches users. The installed app updates from GitHub
 * releases only, which `bun run release:publish` (scripts/release-publish.sh)
 * cuts from a tagged commit after the `publish` tier — never install or swap
 * /Applications/TempCode.app from here. `--push` (a batch's release step on
 * the box, batch.ts) pushes the branch and the new tag to origin after
 * tagging, so the Mac can publish the commit; the post-commit train never
 * passes it. Off macOS the gate skips its Mac-only publish steps (hub, ios,
 * ios-client) with a note; the Mac's publish gate runs them before anything
 * ships. With nothing new since the newest `release-N` (HEAD is that
 * commit, or only release bookkeeping follows it) it prints "nothing to
 * release since release-N" and exits 0 untouched (scripts/releaseCheck.ts).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { commitsSince, nothingLine, nothingToRelease } from './releaseCheck'

// The post-commit hook exports GIT_AUTHOR_*, GIT_INDEX_FILE and friends.
// Leaked into the gate they make every git command in a test act as the
// hook's own commit (gitops.test.ts saw the wrong author), so children
// get a plain environment.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
)
const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env })

const args = process.argv.slice(2)
const full = args.includes('--full')
const push = args.includes('--push')
const notes = args.find((a) => !a.startsWith('--'))?.trim()
if (!notes) {
  console.error('usage: bun scripts/release.ts "one-line release notes" [--full] [--push]')
  process.exit(1)
}

const dirty = run('git', ['status', '--porcelain'])
  .split('\n')
  .filter((l) => l && !l.startsWith('??'))
if (dirty.length > 0) {
  console.error('tree has uncommitted changes — commit your work first:\n' + dirty.join('\n'))
  process.exit(1)
}

const last = JSON.parse(readFileSync('release.json', 'utf8')) as { n: number }
const tag = `release-${last.n}`
const since = commitsSince(tag, process.cwd(), env)

// Nothing new since the newest tag (HEAD is that commit, or every commit
// since is release bookkeeping): no bump, no commit, no tag. With --push the
// branch and the existing tag still go to origin, so a publish after this
// can take the commit the tag names.
if (since && nothingToRelease(since)) {
  if (push) {
    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    execFileSync('git', ['push', 'origin', branch, tag], { stdio: 'inherit', env })
  }
  console.log(nothingLine(tag))
  process.exit(0)
}

// The gate (scripts/gate.ts): the commit tier always, the publish tier when
// the commits since the last release (tag release-N, else the parent) touch
// what it guards. The gate prints its own per-step times.
execFileSync('bun', ['scripts/gate.ts', '--tier', 'commit', '--since', since ? tag : 'HEAD~1', ...(full ? ['--full'] : [])], {
  stdio: 'inherit',
  env
})

const n = last.n + 1
writeFileSync('release.json', JSON.stringify({ n, notes, ts: Date.now() }, null, 2) + '\n')
// package.json carries the same number as a semver electron-updater can
// order: 1.0.N. The regex edit keeps the file's formatting byte for byte.
const pkg = readFileSync('package.json', 'utf8')
if (!/^  "version": "1\.0\.\d+",$/m.test(pkg)) {
  console.error('package.json version is not of the form 1.0.N — refusing to bump')
  process.exit(1)
}
writeFileSync('package.json', pkg.replace(/^  "version": "1\.0\.\d+",$/m, `  "version": "1.0.${n}",`))
run('git', ['add', 'release.json', 'package.json'])
run('git', ['commit', '-m', `release: v${n} — ${notes}`])
run('git', ['tag', `release-${n}`])
if (push) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  execFileSync('git', ['push', 'origin', branch, `release-${n}`], { stdio: 'inherit', env })
  console.log(`pushed ${branch} and release-${n} to origin`)
}
console.log(`released v${n} (tag release-${n}, package.json 1.0.${n}) — publish it with: bun run release:publish`)
