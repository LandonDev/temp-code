/**
 * Cut a release: `bun scripts/release.ts "one-line notes"`.
 *
 * Gates on a clean tree, typecheck, vitest, and a real build, then bumps
 * release.json, commits it, and tags `release-N`. The user's installed
 * app sees the new tag and offers the update — never install or swap
 * /Applications/TempCode.app from here.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })

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
run('git', ['add', 'release.json'])
run('git', ['commit', '-m', `release: v${n} — ${notes}`])
run('git', ['tag', `release-${n}`])
console.log(`released v${n} (tag release-${n}) — the app will offer it on its next check`)
