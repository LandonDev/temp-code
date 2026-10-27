import { describe, expect, it } from 'vitest'
import { badgeText, shouldBounce } from './dockBadge'

describe('badgeText', () => {
  it('shows the largest report, not the sum', () => {
    expect(badgeText([3, 3])).toBe('3')
    expect(badgeText([2, 3])).toBe('3')
  })
  it('is empty at zero and with no window reporting', () => {
    expect(badgeText([0])).toBe('')
    expect(badgeText([])).toBe('')
  })
  it('caps at 99+', () => {
    expect(badgeText([120])).toBe('99+')
    expect(badgeText([99])).toBe('99')
  })
  it("drops a closed window's report", () => {
    const badges = new Map([[1, 4], [2, 1]])
    badges.delete(1)
    expect(badgeText([...badges.values()])).toBe('1')
  })
})

describe('shouldBounce', () => {
  it('bounces when the count rises with no window focused', () => {
    expect(shouldBounce(2, 3, false)).toBe(true)
  })
  it('does not bounce when the count falls or holds', () => {
    expect(shouldBounce(3, 2, false)).toBe(false)
    expect(shouldBounce(3, 3, false)).toBe(false)
  })
  it('does not bounce while a window is focused', () => {
    expect(shouldBounce(2, 3, true)).toBe(false)
  })
})
