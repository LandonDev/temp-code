import { describe, expect, it } from 'vitest'
import { behindCount, driftKindOf, driftMark, driftTitle } from './deployDrift'

describe('behindCount', () => {
  it('is master minus running, never negative', () => {
    expect(behindCount(273, 270)).toBe(3)
    expect(behindCount(273, 273)).toBe(0)
    expect(behindCount(270, 273)).toBe(0)
  })
  it('is null until both numbers are known', () => {
    expect(behindCount(null, 270)).toBeNull()
    expect(behindCount(273, undefined)).toBeNull()
    expect(behindCount(Number.NaN, 270)).toBeNull()
    expect(behindCount(273.5, 270)).toBeNull()
  })
})

describe('driftTitle', () => {
  it('names the count, both versions and the box deploy command', () => {
    expect(driftTitle({ behind: 3, running: 270, master: 273, kind: 'box' })).toBe(
      "3 releases behind master (runs v1.0.270, master is v1.0.273). Deploy with: ssh box 'box-update master'"
    )
  })
  it('says Publish for the Mac, singular for one release', () => {
    expect(driftTitle({ behind: 1, running: 272, master: 273, kind: 'mac' })).toBe(
      '1 release behind master (runs v1.0.272, master is v1.0.273). Publish with: bun run release:publish'
    )
  })
  it('marks as +N and picks the kind by platform', () => {
    expect(driftMark(3)).toBe('+3')
    expect(driftKindOf('darwin')).toBe('mac')
    expect(driftKindOf('linux')).toBe('box')
    expect(driftKindOf(undefined)).toBe('box')
  })
})
