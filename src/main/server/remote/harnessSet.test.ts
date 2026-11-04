import { describe, expect, it } from 'vitest'
import { HARNESS_SET, isSecretPath, ruleFor, setCounts } from './harnessSet'

describe("Muse Code's config in the harness set", () => {
  it('syncs the settings, skills and hooks under ~/.config/muse and never the login', () => {
    expect(ruleFor('.config/muse/settings.json')?.label).toBe('Muse settings')
    expect(ruleFor('.config/muse/skills/review/SKILL.md')?.label).toBe('Muse skills')
    expect(ruleFor('.config/muse/hooks/pre.sh')?.label).toBe('Muse hooks')
    // A skill's per-platform binary cache stays home, as for the other skill trees.
    expect(ruleFor('.config/muse/skills/impeccable/scripts/bin/darwin/engine')).toBeNull()
    expect(ruleFor('.config/muse/auth.json')).toBeNull()
    expect(isSecretPath('.config/muse/auth.json')).toBe(true)
    expect(ruleFor('.config/muse/trust.json')).toBeNull()
    const counts = setCounts([{ relPath: '.config/muse/settings.json' }, { relPath: '.config/muse/skills/a/SKILL.md' }], HARNESS_SET)
    expect(counts['Muse settings']).toBe(1)
    expect(counts['Muse skills']).toBe(1)
    expect(counts['Muse hooks']).toBe(0)
  })
})
