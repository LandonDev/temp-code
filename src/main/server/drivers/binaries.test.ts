import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fake = { path: null as string | null }

vi.mock('./harness/child', async () => ({
  ...(await vi.importActual<typeof import('./harness/child')>('./harness/child')),
  resolveMuseBinary: async () => {
    if (!fake.path) throw new Error('muse not found on the login-shell PATH')
    return { path: fake.path }
  }
}))

const { checkProvider } = await import('./binaries')

describe('the doctor row for Muse Code', () => {
  it('names the version the launcher prints when the binary is installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-doctor-'))
    const bin = join(dir, 'muse')
    writeFileSync(bin, '#!/bin/sh\necho "Muse Code 1.4.14 (1.4.14-R7309.1)"\n')
    chmodSync(bin, 0o755)
    fake.path = bin
    const report = await checkProvider('muse')
    expect(report).toEqual({ found: true, path: bin, version: 'Muse Code 1.4.14 (1.4.14-R7309.1)' })
  })

  it('reports the finder\'s words when the binary is absent', async () => {
    fake.path = null
    const report = await checkProvider('muse')
    expect(report.found).toBe(false)
    expect(report.error).toMatch(/muse not found/)
  })
})
