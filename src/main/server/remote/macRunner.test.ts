import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runMacCommand, scrubbedEnv, shellArgv } from './macRunner'

const dir = mkdtempSync(join(tmpdir(), 'tc-macrun-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const SH = '/bin/sh'
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('scrubbedEnv', () => {
  it('keeps who and where, drops the app\'s own and every secret', () => {
    const env = scrubbedEnv({ HOME: '/Users/me', USER: 'me', SHELL: '/bin/zsh', TEMP_CODE_USER_DATA: '/x', ANTHROPIC_API_KEY: 'sk', ELECTRON_RUN_AS_NODE: '1', GITHUB_TOKEN: 't', PATH: '/evil' })
    expect(env.HOME).toBe('/Users/me')
    expect(env.USER).toBe('me')
    expect(env.PATH).not.toContain('/evil')
    for (const k of ['TEMP_CODE_USER_DATA', 'ANTHROPIC_API_KEY', 'ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN']) expect(env[k]).toBeUndefined()
  })
})

describe('shellArgv', () => {
  it('passes argv through "$@" untouched and a command string as the shell reads it', () => {
    expect(shellArgv({ argv: ['echo', 'a b', '$HOME'] }, '/bin/zsh')).toEqual(['/bin/zsh', '-lc', 'exec "$@"', 'mac-bridge', 'echo', 'a b', '$HOME'])
    expect(shellArgv({ command: 'ls | wc -l' }, '/bin/bash')).toEqual(['/bin/bash', '-lc', 'ls | wc -l'])
    expect(() => shellArgv({})).toThrow()
  })
})

describe('runMacCommand', () => {
  it('runs argv with no word splitting, in the cwd, with no stdin and the scrubbed env', async () => {
    const run = runMacCommand({ argv: ['/bin/sh', '-c', 'printf "%s|" "$1" "$(pwd)" "${TEMP_CODE_SECRET:-none}"; cat; echo done >&2', 'x', 'a b'], cwd: dir, timeoutMs: 10_000, shell: SH, env: { ...scrubbedEnv(), HOME: dir } })
    const r = await run.result
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(`a b|${dir}|none|`)
    expect(r.stderr).toBe('done\n')
    expect(r.truncated).toBe(false)
    expect(r.timedOut).toBe(false)
  })

  it('reports a failing exit code', async () => {
    const r = await runMacCommand({ command: 'exit 3', cwd: dir, timeoutMs: 10_000, shell: SH }).result
    expect(r.exitCode).toBe(3)
  })

  it('kills the whole process group on the timeout', async () => {
    const pidFile = join(dir, 'grandchild.pid')
    const started = Date.now()
    const r = await runMacCommand({ command: `sleep 30 & echo $! > ${pidFile}; wait`, cwd: dir, timeoutMs: 500, shell: SH }).result
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
    const grandchild = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'))
    await new Promise((ok) => setTimeout(ok, 200))
    expect(alive(grandchild)).toBe(false)
  })

  it('caps output at the limit, says truncated and kills the group', async () => {
    const r = await runMacCommand({ command: 'yes 0123456789', cwd: dir, timeoutMs: 10_000, shell: SH, outputCap: 64 * 1024 }).result
    expect(r.truncated).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBe(64 * 1024)
  })

  it('stop() kills a running command', async () => {
    const run = runMacCommand({ command: 'sleep 30', cwd: dir, timeoutMs: 60_000, shell: SH })
    setTimeout(() => run.stop(), 200)
    const r = await run.result
    expect(r.signal ?? r.exitCode).not.toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.durationMs).toBeLessThan(5_000)
  })
})
