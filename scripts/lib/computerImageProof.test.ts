import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/shared/events'
import { formatShotLine } from '../../src/shared/computer/tools'
import { judgeComputerImages } from './computerImageProof'

const shot = '/tmp/attachments/a shot.png'
const base: AgentEvent[] = [
  {
    type: 'tool-call',
    callId: 'c1',
    name: 'app.computer_observe',
    input: { app: 'TextEdit', screenshot: true }
  },
  {
    type: 'tool-result',
    callId: 'c1',
    output: formatShotLine(1, 'observation', { path: shot, width: 1280, height: 800 }, true),
    isError: false
  },
  { type: 'assistant-text', text: 'ACDEFG', delta: false }
]
const read = (name: string): AgentEvent => ({
  type: 'tool-call',
  callId: 'read',
  name,
  input: { path: shot, command: `cat '${shot}'` }
})

describe('picture proof verdict', () => {
  it('requires the code, requested observation and all pictures', () => {
    expect(judgeComputerImages(base, 'ACDEFG', 'parts', 1).pass).toBe(true)
    expect(judgeComputerImages(base, 'ACDEFG', 'steer', 1).pass).toBe(true)
    expect(judgeComputerImages(base, 'QWERTY', 'parts', 1).pass).toBe(false)
    expect(judgeComputerImages(base, 'ACDEFG', 'parts', 2).why).toContain('expected 2 pictures')
    expect(judgeComputerImages(base.slice(1), 'ACDEFG', 'parts', 1).why).toContain(
      'no screenshot observation'
    )
  })
  it.each(['Read', 'view_image', 'shell', 'Bash', 'exec_command'])(
    'fails fallback reads with %s even with a correct reply',
    (name) => {
      expect(judgeComputerImages([...base, read(name)], 'ACDEFG', 'parts', 1).why).toContain(
        'opened a shot file'
      )
      expect(judgeComputerImages([...base, read(name)], 'ACDEFG', 'steer', 1).pass).toBe(false)
    }
  )
  it('requires view_image in view mode and still rejects shell and Read', () => {
    expect(judgeComputerImages(base, 'ACDEFG', 'view', 1).pass).toBe(false)
    expect(judgeComputerImages([...base, read('view_image')], 'ACDEFG', 'view', 1).pass).toBe(true)
    expect(
      judgeComputerImages([...base, read('view_image'), read('Read')], 'ACDEFG', 'view', 1).pass
    ).toBe(false)
  })
  it('reads Codex JSON results and rejects a harness error', () => {
    const json: AgentEvent[] = base.map((e) =>
      e.type === 'tool-result'
        ? { ...e, output: JSON.stringify({ content: [{ type: 'text', text: e.output }] }) }
        : e
    )
    expect(judgeComputerImages(json, 'ACDEFG', 'parts', 1).pass).toBe(true)
    expect(
      judgeComputerImages(
        [...json, { type: 'error', message: 'authentication failed' }],
        'ACDEFG',
        'parts',
        1
      ).why
    ).toBe('authentication failed')
  })
})
