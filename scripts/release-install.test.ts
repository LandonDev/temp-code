import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const publish = readFileSync(join(__dirname, 'release-publish.sh'), 'utf8')
const setup = publish.slice(0, publish.indexOf('# ── the checks'))
const install = publish.slice(publish.indexOf('# ── install, before'), publish.indexOf('# ── gate, beside'))
const fixtures: string[] = []

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-release-install-'))
  fixtures.push(dir)
  const home = join(dir, 'home')
  mkdirSync(join(home, '.bun/bin'), { recursive: true })
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true })
  for (const lib of ['release-install.sh', 'release-notes.sh']) {
    copyFileSync(join(__dirname, 'lib', lib), join(dir, 'scripts/lib', lib))
  }
  // Use the real phase helpers, exit trap, and install call; stop before any gate or build.
  const harness = join(dir, 'scripts/install-test.sh')
  writeFileSync(harness, `${setup}\n${install}\nprintf 'reached gate/build\\n'\n`)
  writeFileSync(join(dir, 'bun.lock'), 'first lockfile\n')
  writeFileSync(join(home, '.bun/bin/bun'), `#!/bin/sh
printf '%s\\n' "$*" >> bun-calls
[ ! -e node_modules/.tc-installed-lock ] || exit 9
n=1
while [ "$n" -le 45 ]; do
  echo "install output $n"
  n=$((n + 1))
done
[ "\${MOCK_INSTALL_FAIL:-0}" = 0 ] || exit 7
mkdir -p node_modules
`, { mode: 0o755 })
  const marker = join(dir, 'node_modules/.tc-installed-lock')
  return {
    dir,
    marker,
    digest: () => createHash('sha256').update(readFileSync(join(dir, 'bun.lock'))).digest('hex') + '\n',
    calls: () => existsSync(join(dir, 'bun-calls')) ? readFileSync(join(dir, 'bun-calls'), 'utf8') : '',
    run: (fail = false) => spawnSync('bash', [harness], {
      cwd: dir,
      env: { ...process.env, HOME: home, MOCK_INSTALL_FAIL: fail ? '1' : '0' },
      encoding: 'utf8'
    })
  }
}

describe('publish dependency install', () => {
  it('installs with a frozen lockfile when the marker and node_modules are missing', () => {
    const f = fixture()
    const result = f.run()
    expect(result.status).toBe(0)
    expect(f.calls()).toBe('install --frozen-lockfile\n')
    expect(readFileSync(f.marker, 'utf8')).toBe(f.digest())
    expect(readFileSync(join(f.dir, 'bun.lock'), 'utf8')).toBe('first lockfile\n')
    expect(result.stdout).toMatch(/^phase › install\nphase ✓ install \d+s\nreached gate\/build\n$/)
  })

  it('skips only when the installed digest matches, without running Bun or changing the marker', () => {
    const f = fixture()
    expect(f.run().status).toBe(0)
    const result = f.run()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('phase – install skipped (lockfile unchanged)\nreached gate/build\n')
    expect(f.calls()).toBe('install --frozen-lockfile\n')
    expect(readFileSync(f.marker, 'utf8')).toBe(f.digest())
  })

  it('installs again when bun.lock changes and replaces the old digest', () => {
    const f = fixture()
    expect(f.run().status).toBe(0)
    writeFileSync(join(f.dir, 'bun.lock'), 'new git pin\n')
    expect(f.run().status).toBe(0)
    expect(f.calls()).toBe('install --frozen-lockfile\n'.repeat(2))
    expect(readFileSync(f.marker, 'utf8')).toBe(f.digest())
  })

  it('installs when node_modules exists but its marker is missing', () => {
    const f = fixture()
    mkdirSync(join(f.dir, 'node_modules'))
    expect(f.run().status).toBe(0)
    expect(f.calls()).toBe('install --frozen-lockfile\n')
    expect(readFileSync(f.marker, 'utf8')).toBe(f.digest())
  })

  it('stops on install failure, prints its last 40 lines, and leaves no marker', () => {
    const f = fixture()
    const result = f.run(true)
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^phase › install\nphase ✗ install \d+s\n$/)
    expect(result.stderr).toBe(Array.from({ length: 40 }, (_, i) => `install output ${i + 6}\n`).join(''))
    expect(existsSync(f.marker)).toBe(false)
    expect(f.run().status).toBe(0)
    expect(readFileSync(f.marker, 'utf8')).toBe(f.digest())
  })

  it('invalidates the old marker on failure so reverting the lockfile still installs', () => {
    const f = fixture()
    expect(f.run().status).toBe(0)
    writeFileSync(join(f.dir, 'bun.lock'), 'new git pin\n')
    expect(f.run(true).status).toBe(1)
    expect(existsSync(f.marker)).toBe(false)
    writeFileSync(join(f.dir, 'bun.lock'), 'first lockfile\n')
    expect(f.run().status).toBe(0)
    expect(f.calls()).toBe('install --frozen-lockfile\n'.repeat(3))
  })

  it('places install before the gate skip branch and the build', () => {
    expect(install).toContain('install_publish_dependencies "$STAGE/install.log" || exit 1')
    const start = publish.indexOf(install)
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThan(publish.indexOf('if [ -n "$GATE_SKIP" ]'))
    expect(start).toBeLessThan(publish.indexOf('begin build'))
  })
})
