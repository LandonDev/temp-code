import { describe, expect, it } from 'vitest'
import {
  ACK_HIGH_WATER,
  ACK_LOW_WATER,
  FlowControl,
  PTY_CHUNK,
  commandLabel,
  defaultShell,
  foregroundLabel,
  loginArgs,
  shouldFlush
} from './pty-core'

describe('batching', () => {
  it('holds a small read until the coalesce window closes', () => {
    expect(shouldFlush(64, 0)).toBe(false)
    expect(shouldFlush(64, 8)).toBe(true)
  })

  it('flushes a full chunk immediately', () => {
    expect(shouldFlush(PTY_CHUNK, 0)).toBe(true)
  })
})

describe('flow control', () => {
  it('pauses once above the high-water mark and resumes below the low one', () => {
    const flow = new FlowControl()
    expect(flow.sent(ACK_HIGH_WATER)).toBe(false)
    expect(flow.sent(1)).toBe(true)
    expect(flow.paused).toBe(true)
    // A second send while paused must not pause again.
    expect(flow.sent(1000)).toBe(false)
    expect(flow.pauses).toBe(1)

    // Still above the low-water mark: no resume yet.
    expect(flow.acked(ACK_HIGH_WATER - ACK_LOW_WATER)).toBe(false)
    expect(flow.paused).toBe(true)
    expect(flow.acked(ACK_LOW_WATER)).toBe(true)
    expect(flow.paused).toBe(false)
    expect(flow.resumes).toBe(1)
  })

  it('never goes into credit debt below zero', () => {
    const flow = new FlowControl()
    flow.sent(10)
    flow.acked(500)
    expect(flow.pending).toBe(0)
  })
})

describe('shell selection', () => {
  it('logs in for the common shells only', () => {
    expect(loginArgs('/bin/zsh')).toEqual(['-l'])
    expect(loginArgs('/opt/homebrew/bin/fish')).toEqual(['-l'])
    expect(loginArgs('/usr/bin/nu')).toEqual([])
  })

  it('falls back per platform', () => {
    expect(defaultShell('darwin', {}).shell).toBe('/bin/zsh')
    expect(defaultShell('linux', {}).shell).toBe('/bin/bash')
    expect(defaultShell('darwin', { SHELL: '/bin/bash' })).toEqual({
      shell: '/bin/bash',
      args: ['-l']
    })
  })
})

describe('foreground label', () => {
  const ps = (lines: string[]): string => lines.join('\n')

  it('is null while the shell itself is in front', () => {
    expect(foregroundLabel(ps(['  501   501 Ss+   -zsh']), 501)).toBe(null)
  })

  it('names the running command', () => {
    const out = ps([
      '  501   501 Ss    -zsh',
      '  733   733 S+    /usr/bin/vim notes.md',
      '  740   733 S+    /usr/bin/less'
    ])
    expect(foregroundLabel(out, 501)).toBe('vim')
  })

  it('reads past an interpreter to the script', () => {
    expect(commandLabel('/usr/local/bin/node /Users/x/.bin/npm run build')).toBe('npm')
    expect(commandLabel('python3 -u manage.py runserver')).toBe('manage.py')
    expect(commandLabel('/bin/cat big.txt')).toBe('cat')
  })

  it('ignores a nested shell', () => {
    expect(foregroundLabel(ps(['  900   900 S+    /bin/bash']), 501)).toBe(null)
  })
})
