import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ text: '' }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() =>
    (async function* () {
      yield { type: 'result', subtype: 'success', result: state.text }
    })()
  )
}))
vi.mock('./binaries', () => ({
  resolveClaude: vi.fn(async () => ({ path: '/test/claude', version: null })),
  harnessEnv: vi.fn(async () => ({}))
}))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { generateText, generateTitle } from './title'

beforeEach(() => {
  vi.clearAllMocks()
})
function success(text: string): void {
  state.text = text
}
it('generates general text without title caps, tools, or a session', async () => {
  const text = 'A long body\n'.repeat(15)
  success(text)
  expect(await generateText('Write a body', { cwd: '/tmp/project' })).toBe(text.trim())
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'Write a body',
      options: expect.objectContaining({
        pathToClaudeCodeExecutable: '/test/claude',
        tools: [],
        maxTurns: 1,
        cwd: '/tmp/project'
      })
    })
  )
})
it('keeps title limits and returns null on failures', async () => {
  success('"Small title."')
  expect(await generateTitle('message')).toBe('Small title')
  success('a'.repeat(61))
  expect(await generateTitle('message')).toBeNull()
  vi.mocked(query).mockImplementation(() => {
    throw new Error('unavailable')
  })
  expect(await generateText('prompt')).toBeNull()
})
