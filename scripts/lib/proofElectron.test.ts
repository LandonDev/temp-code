import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { proofElectron } from './proofElectron'

it('runs the clone executable with a sparse PATH and no node launcher', () => {
  const repo = mkdtempSync(join(tmpdir(), 'proof electron '))
  const pkg = join(repo, 'node_modules/electron')
  const entry = 'Electron.app/Contents/MacOS/Electron'
  const binary = join(pkg, 'dist', entry)
  try {
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(join(pkg, 'path.txt'), `${entry}\n`)
    writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 })
    expect(proofElectron(repo)).toBe(binary)
    expect(
      execFileSync(proofElectron(repo), ['.'], { env: { PATH: '/nonexistent' }, encoding: 'utf8' })
    ).toBe('.')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

it('names the clone install step if the distribution is missing', () => {
  const repo = mkdtempSync(join(tmpdir(), 'proof-electron-missing-'))
  try {
    expect(() => proofElectron(repo)).toThrow('bun node_modules/electron/install.js')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
