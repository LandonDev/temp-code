import { describe, expect, it } from 'vitest'
import { HARNESS_SET, isSecretPath, reachableUnderHome, ruleFor, setCounts } from './harnessSet'

describe("Muse Code's config in the harness set", () => {
  it('syncs the settings and hooks under ~/.config/muse, never its skills (the store\'s) or the login', () => {
    expect(ruleFor('.config/muse/settings.json')?.label).toBe('Muse settings')
    expect(ruleFor('.config/muse/skills/review/SKILL.md')).toBeNull()
    expect(ruleFor('.config/muse/hooks/pre.sh')?.label).toBe('Muse hooks')
    expect(ruleFor('.config/muse/auth.json')).toBeNull()
    expect(isSecretPath('.config/muse/auth.json')).toBe(true)
    expect(ruleFor('.config/muse/trust.json')).toBeNull()
    const counts = setCounts([{ relPath: '.config/muse/settings.json' }, { relPath: '.config/muse/skills/a/SKILL.md' }], HARNESS_SET)
    expect(counts['Muse settings']).toBe(1)
    expect('Muse skills' in counts).toBe(false)
    expect(counts['Muse hooks']).toBe(0)
  })
})

describe('reachableUnderHome', () => {
  it('follows a link inside HOME and never into a credential dir or out of HOME', () => {
    const home = '/home/me'
    expect(reachableUnderHome('/home/me/IdeaProjects/skills/tidy', home)).toBe(true)
    expect(reachableUnderHome('/home/me', home)).toBe(true)
    for (const dir of ['.ssh', '.gnupg', '.aws', '.config/gh', '.docker', '.kube', 'Library/Keychains', '.aliax']) expect(reachableUnderHome(`/home/me/${dir}/x`, home)).toBe(false)
    expect(reachableUnderHome('/home/meh/x', home)).toBe(false)
    expect(reachableUnderHome('/opt/skills/tidy', home)).toBe(false)
  })
})
