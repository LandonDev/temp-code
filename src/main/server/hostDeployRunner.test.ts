import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEPLOY_REF } from '@shared/contract-host'

/** The root side (scripts/box/deploy-runner.sh) against a scratch trigger directory and a fake box-update. */
const RUNNER = resolve(__dirname, '../../../scripts/box/deploy-runner.sh')

let root: string
let dir: string
let fakeUpdate: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-runner-'))
  dir = join(root, 'deploy')
  mkdirSync(dir)
  fakeUpdate = join(root, 'box-update')
  writeFileSync(fakeUpdate, '#!/bin/sh\necho "building $1"\necho "ERROR: simulated" >&2\nexit "${FAKE_EXIT:-0}"\n')
  chmodSync(fakeUpdate, 0o755)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = (env: Record<string, string> = {}) =>
  execFileSync('bash', [RUNNER], { env: { ...process.env, TEMP_CODE_DEPLOY_DIR: dir, TEMP_CODE_BOX_UPDATE: fakeUpdate, ...env }, encoding: 'utf8' })
const read = (name: string) => readFileSync(join(dir, name), 'utf8')

describe('deploy-runner.sh', () => {
  it('does nothing without a request', () => {
    run()
    expect(existsSync(join(dir, 'log'))).toBe(false)
  })
  it('runs box-update with the ref, its output in the log, and writes exit last', () => {
    writeFileSync(join(dir, 'request'), 'master\n')
    run()
    expect(existsSync(join(dir, 'request'))).toBe(false)
    expect(read('ref')).toBe('master\n')
    expect(read('log')).toContain('building master\n')
    expect(read('log')).toContain('ERROR: simulated\n')
    expect(read('log')).toContain('== box-update exited 0')
    expect(read('exit')).toBe('0\n')
    writeFileSync(join(dir, 'request'), 'v1.0.273\n')
    run({ FAKE_EXIT: '3' })
    expect(read('ref')).toBe('v1.0.273\n')
    expect(read('log')).not.toContain('building master')
    expect(read('log')).toContain('building v1.0.273')
    expect(read('exit')).toBe('3\n')
  })
  it('refuses any other ref without running box-update, with the same rule the app checks', () => {
    for (const bad of ['main', 'v1.0', 'v2.0.1', 'master; rm -rf /', '../x', 'release-3', 'master\nextra']) {
      writeFileSync(join(dir, 'request'), `${bad}\n`)
      run()
      expect(read('exit')).toBe('2\n')
      expect(read('log')).toContain('refused ref')
      expect(read('log')).not.toContain('building')
      expect(DEPLOY_REF.test(bad.split('\n')[0])).toBe(bad.split('\n')[0] === 'master')
    }
  })
})
