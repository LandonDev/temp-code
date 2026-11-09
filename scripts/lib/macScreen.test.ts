import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateScreenSkip, parseMacScreen, readMacScreen, SCREEN_SKIP_LINE } from './macScreen'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('the screen probe replies', () => {
  // Locked reply recorded on the Mac on 2026-11-09; the other states keep its wire shape.
  it.each([
    ['{"locked":true,"asleep":false}\n', { locked: true, asleep: false }],
    ['{"locked":false,"asleep":false}\n', { locked: false, asleep: false }],
    ['{"asleep":false,"locked":true}\n', { locked: true, asleep: false }],
    ['{"locked":false,"asleep":true}\n', { locked: false, asleep: true }],
    ['{"locked":true,"asleep":true}\n', { locked: true, asleep: true }]
  ])('reads the probe JSON %s', (sample, expected) => {
    expect(parseMacScreen(sample)).toEqual(expected)
  })

  it.each(['', 'not json', '{}', 'null', '[]', '{"locked":"false","asleep":false}', '{"locked":false}'])('treats %s as unreadable', (sample) => {
    expect(parseMacScreen(sample)).toBeNull()
  })

  it('compiles once, reuses the binary and bounds each command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-screen-'))
    const exec = vi.mocked(execFileSync)
    exec.mockImplementation(((file: string, args: string[]) => {
      if (file === '/usr/bin/xcrun') {
        writeFileSync(args.at(-1)!, 'fake binary')
        return Buffer.from('')
      }
      expect(existsSync(file)).toBe(true)
      return '{"locked":false,"asleep":false}\n'
    }) as typeof execFileSync)
    try {
      expect(readMacScreen(dir)).toEqual({ locked: false, asleep: false })
      expect(readMacScreen(dir)).toEqual({ locked: false, asleep: false })
      expect(exec).toHaveBeenCalledTimes(3)
      expect(exec.mock.calls[0]).toEqual(['/usr/bin/xcrun', expect.arrayContaining(['swiftc', '-o']), expect.objectContaining({ timeout: 1800 })])
      for (const call of exec.mock.calls.slice(1)) expect(call[2]).toMatchObject({ timeout: 400 })
      expect(readdirSync(dir)).toEqual([expect.stringMatching(/^screen-[a-f0-9]{12}$/)])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives execution only the time left after a slow cold compile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-screen-budget-'))
    const exec = vi.mocked(execFileSync)
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2800)
    exec.mockImplementation(((file: string, args: string[]) => {
      if (file === '/usr/bin/xcrun') writeFileSync(args.at(-1)!, 'fake binary')
      return '{"locked":true,"asleep":false}'
    }) as typeof execFileSync)
    try {
      expect(readMacScreen(dir)).toEqual({ locked: true, asleep: false })
      expect(exec.mock.calls[1][2]).toMatchObject({ timeout: 150 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a cached probe read failure as unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-screen-read-'))
    const exec = vi.mocked(execFileSync)
    exec.mockImplementationOnce(((_file: string, args: string[]) => {
      writeFileSync(args.at(-1)!, 'fake binary')
      return Buffer.from('')
    }) as typeof execFileSync).mockImplementation(() => { throw new Error('read timeout') })
    try {
      expect(readMacScreen(dir)).toBeNull()
      expect(readMacScreen(dir)).toBeNull()
      expect(exec).toHaveBeenCalledTimes(3)
      expect(readdirSync(dir)).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats compile failure or timeout as unreadable and removes partial output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-screen-'))
    vi.mocked(execFileSync).mockImplementation(((_file: string, args: string[]) => {
      writeFileSync(args.at(-1)!, 'partial binary')
      throw new Error('ETIMEDOUT')
    }) as typeof execFileSync)
    try {
      expect(readMacScreen(dir)).toBeNull()
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('direct --gate proof admission', () => {
  it.each([
    () => ({ locked: true, asleep: false }),
    () => ({ locked: false, asleep: true }),
    () => null,
    () => { throw new Error('read failed') }
  ])('returns the one skip line for an unavailable screen', (read) => {
    expect(gateScreenSkip(true, '/repo', 'darwin', read)).toBe(SCREEN_SKIP_LINE)
  })

  it('lets an unlocked gate run and never checks hand runs or hosts off macOS', () => {
    const read = vi.fn(() => ({ locked: false, asleep: false }))
    expect(gateScreenSkip(true, '/repo', 'darwin', read)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    read.mockClear()
    expect(gateScreenSkip(false, '/repo', 'darwin', read)).toBeNull()
    expect(gateScreenSkip(true, '/repo', 'linux', read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
