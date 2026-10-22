import { describe, expect, it } from 'vitest'
import { FocusSet } from './focus'

/** parent → child edges and root → master edges, as the index answers them. */
function links(parents: Record<string, string>, masters: Record<string, string> = {}) {
  return { parentOf: (id: string) => parents[id] ?? null, masterOf: (id: string) => masters[id] ?? null }
}

describe('FocusSet', () => {
  it('a focused thread brings its whole subagent chain, never its parent or siblings', () => {
    const set = new FocusSet(links({ sub: 'root', subsub: 'sub', other: 'root' }))
    set.set(1, 'sub')
    expect(set.isInteractive('sub')).toBe(true)
    expect(set.isInteractive('subsub')).toBe(true)
    expect(set.isInteractive('root')).toBe(false)
    expect(set.isInteractive('other')).toBe(false)
  })

  it('a focused master brings every root carrying its id and their subagents', () => {
    const set = new FocusSet(links({ childSub: 'child' }, { child: 'master', stranger: 'elsewhere' }))
    set.set(1, 'master')
    expect(set.isInteractive('child')).toBe(true)
    expect(set.isInteractive('childSub')).toBe(true)
    expect(set.isInteractive('stranger')).toBe(false)
  })

  it('is the union across sockets, counted, and a socket answers only for its own focus', () => {
    const set = new FocusSet(links({}))
    set.set(1, 'x')
    set.set(2, 'x')
    set.set(3, 'y')
    expect(set.focused().sort()).toEqual(['x', 'y'])
    set.drop(1)
    expect(set.isInteractive('x')).toBe(true)
    set.set(2, 'z')
    expect(set.isInteractive('x')).toBe(false)
    expect(set.isFocusedBy(2, 'z')).toBe(true)
    expect(set.isFocusedBy(3, 'z')).toBe(false)
    set.set(3, null)
    expect(set.focusOf(3)).toBeNull()
    expect(set.focused()).toEqual(['z'])
  })
})
