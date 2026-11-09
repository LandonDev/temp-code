import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { binarySpellings } from './tcProbeApp'

describe('binarySpellings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-probe-spell-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('adds /private before /tmp, the way Launch Services starts an app there', () => {
    const bin = '/tmp/tc-preview-proof/TC Probe.app/Contents/MacOS/TC Probe'
    expect(binarySpellings(bin)).toEqual([bin, `/private${bin}`])
  })

  it('drops /private from a /private/tmp path, so either spelling matches', () => {
    const bin = '/private/tmp/tc-computer-ui/TC Probe.app/Contents/MacOS/TC Probe'
    expect(binarySpellings(bin)).toEqual([bin, '/tmp/tc-computer-ui/TC Probe.app/Contents/MacOS/TC Probe'])
  })

  it('adds the real path of a binary reached through a link', () => {
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    const spellings = binarySpellings(join(dir, 'link'))
    expect(spellings[0]).toBe(join(dir, 'link'))
    expect(spellings).toContain(realpathSync(join(dir, 'real')))
  })

  it('leaves any other path as it is', () => {
    expect(binarySpellings('/Users/me/probe/TC Probe')).toEqual(['/Users/me/probe/TC Probe'])
  })
})
