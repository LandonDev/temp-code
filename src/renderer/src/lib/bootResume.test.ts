// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { bootResumeLine, dismissBootResume, noteBootResume, resetBootResume, useBootResumeNotice } from './bootResume'
import { renderHook } from '@testing-library/react'

// Node 26 defines a localStorage global of its own (undefined without
// --localstorage-file) that vitest's jsdom environment leaves in place, so
// the test brings its own, the way tabGroups.cache.test.ts does.
const data = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size },
  },
})

describe('boot-resume notice', () => {
  beforeEach(() => {
    resetBootResume()
    localStorage.clear()
  })

  it('shows a host\'s count once per boot, even when the push repeats', () => {
    noteBootResume('box', 7, 1000)
    const { result } = renderHook(() => useBootResumeNotice('box'))
    expect(result.current).toEqual({ environmentId: 'box', count: 7, at: 1000 })
    dismissBootResume('box')
    // The same boot's push on a reconnect says nothing new.
    noteBootResume('box', 7, 1000)
    expect(renderHook(() => useBootResumeNotice('box')).result.current).toBeNull()
    // The next boot does.
    noteBootResume('box', 2, 2000)
    expect(renderHook(() => useBootResumeNotice('box')).result.current).toMatchObject({ count: 2 })
  })

  it('a zero count is no notice, and hosts are kept apart', () => {
    noteBootResume('box', 0, 1000)
    noteBootResume('mac', 1, 1000)
    expect(renderHook(() => useBootResumeNotice('box')).result.current).toBeNull()
    expect(renderHook(() => useBootResumeNotice('mac')).result.current).toMatchObject({ count: 1 })
    expect(renderHook(() => useBootResumeNotice(undefined)).result.current).toBeNull()
  })

  it('words the line by count', () => {
    expect(bootResumeLine(1)).toBe('1 thread resumed after restart')
    expect(bootResumeLine(7)).toBe('7 threads resumed after restart')
  })
})
