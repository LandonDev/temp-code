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

  it('isNamed is the exact thread a socket names, never widened', () => {
    const set = new FocusSet(links({ sub: 'root' }, { child: 'master' }))
    set.set(1, 'sub')
    set.set(2, 'master')
    expect(set.isNamed('sub')).toBe(true)
    expect(set.isNamed('master')).toBe(true)
    expect(set.isNamed('root')).toBe(false)
    expect(set.isNamed('child')).toBe(false)
    set.drop(1)
    expect(set.isNamed('sub')).toBe(false)
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

  it('shown: what a socket\'s window displays, widened as focus is, replaced, and dropped with the socket', () => {
    const set = new FocusSet(links({ sub: 'root' }, { child: 'master' }))
    set.setShown(1, 'root')
    expect(set.isShownBy(1, 'root')).toBe(true)
    expect(set.isShownBy(1, 'sub')).toBe(true)
    expect(set.isShownBy(2, 'root')).toBe(false)
    set.setShown(1, 'master')
    expect(set.isShownBy(1, 'root')).toBe(false)
    expect(set.isShownBy(1, 'child')).toBe(true)
    set.setShown(1, null)
    expect(set.isShownBy(1, 'master')).toBe(false)
    set.setShown(1, 'root')
    set.drop(1)
    expect(set.isShownBy(1, 'root')).toBe(false)
  })

  it('shown makes a socket\'s rows immediate and nothing else: focus, the union and isNamed ignore it', () => {
    const set = new FocusSet(links({ sub: 'root' }))
    set.setShown(1, 'root')
    expect(set.pushesAtOnce(1, 'sub')).toBe(true)
    expect(set.pushesAtOnce(2, 'sub')).toBe(false)
    expect(set.isFocusedBy(1, 'root')).toBe(false)
    expect(set.isInteractive('root')).toBe(false)
    expect(set.isNamed('root')).toBe(false)
    expect(set.focused()).toEqual([])
    set.set(1, 'other')
    expect(set.pushesAtOnce(1, 'other')).toBe(true)
    expect(set.pushesAtOnce(1, 'root')).toBe(true)
  })
})
