import { describe, expect, it } from 'vitest'
import { parseCodexVersion } from './codexVersion'

describe('parseCodexVersion', () => {
  it('reads the dotted version out of the CLI banner', () => {
    expect(parseCodexVersion('codex-cli 0.162.1\n')).toBe('0.162.1')
    expect(parseCodexVersion('codex-cli 0.158.0-alpha.2.1')).toBe('0.158.0-alpha.2.1')
    expect(parseCodexVersion('garbage')).toBeNull()
  })
})
