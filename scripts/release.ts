/**
 * Cut a local release: `bun scripts/release.ts "one-line notes"`.
 *
 * Gates on a clean tree, typecheck, vitest, and a real build, then bumps
 * release.json to N and package.json to 1.0.N, commits both, and tags
 * `release-N`. That is the whole of the local train: nothing here reaches
 * users. The installed app updates from GitHub releases only, which
 * `bun run release:publish` (scripts/release-publish.sh) cuts from a tagged
 * commit — never install or swap /Applications/TempCode.app from here.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

// The post-commit hook exports GIT_AUTHOR_*, GIT_INDEX_FILE and friends.
// Leaked into the gate they make every git command in a test act as the
// hook's own commit (gitops.test.ts saw the wrong author), so children
// get a plain environment.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
)
const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env })

const notes = process.argv[2]?.trim()
if (!notes) {
  console.error('usage: bun scripts/release.ts "one-line release notes"')
  process.exit(1)
}

const dirty = run('git', ['status', '--porcelain'])
  .split('\n')
  .filter((l) => l && !l.startsWith('??'))
if (dirty.length > 0) {
  console.error('tree has uncommitted changes — commit your work first:\n' + dirty.join('\n'))
  process.exit(1)
}

console.log('› typecheck')
run('bun', ['run', 'typecheck'])
console.log('› vitest')
run('bunx', ['vitest', 'run'])
console.log('› build')
run('bunx', ['electron-vite', 'build'])

const rel = JSON.parse(readFileSync('release.json', 'utf8')) as { n: number }
const n = rel.n + 1
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
console.log(`released v${n} (tag release-${n}, package.json 1.0.${n}) — publish it with: bun run release:publish`)
