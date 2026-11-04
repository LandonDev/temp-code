import { describe, expect, it } from 'vitest'
import {
  answersOf,
  approvalChoice,
  approvalTitle,
  foldDelta,
  foldItem,
  mcpServersOf,
  questionsOf,
  resetWords,
  retryWords,
  serveArgs,
  sessionResumeParams,
  sessionStartParams,
  toolTitle,
  turnError,
  turnInput
} from './museProtocol'

const bridge = { command: '/usr/bin/node', args: ['/app/scripts/app-mcp-bridge.mjs'], env: { TEMP_CODE_PORT: '4321', TEMP_CODE_SESSION: 's1' }, tool_timeout_sec: 86_400 }

describe('session params', () => {
  it('maps the permission policy onto the profile and the approval mode, the bridge onto a stdio MCP server', () => {
    expect(sessionStartParams({ cwd: '/w', model: 'muse-spark-1.3', permission: 'safe' })).toEqual({ workspaceRoot: '/w', modelId: 'muse-spark-1.3', permissionProfile: ':ask-me', approvalMode: 'promptUnmatched' })
    expect(sessionStartParams({ cwd: '/w', model: '', permission: 'edits' })).toEqual({ workspaceRoot: '/w', permissionProfile: ':ask-me', approvalMode: 'onRequest' })
    const auto = sessionStartParams({ cwd: '/w', model: 'm', permission: 'auto', bridge })
    expect(auto.permissionProfile).toBe(':unrestricted')
    expect(auto.approvalMode).toBe('allowAll')
    expect(auto.config).toEqual({ mcpServers: { app: { transport: 'stdio', command: '/usr/bin/node', args: ['/app/scripts/app-mcp-bridge.mjs'], env: bridge.env, mode: 'optional' } } })
    expect(mcpServersOf(null)).toBeUndefined()
    expect(sessionResumeParams('abc', { cwd: '/w', model: 'm', permission: 'edits', bridge })).toMatchObject({ sessionId: 'abc', modelId: 'm', permissionProfile: ':ask-me', config: { mcpServers: { app: { transport: 'stdio' } } } })
  })

  it('turn input: the text first, images inline, other files named as paths', async () => {
    const parts = await turnInput('hi', [
      { path: '/no/such.png', name: 'such.png', kind: 'image', mime: 'image/png' } as never,
      { path: '/tmp/notes.txt', name: 'notes.txt', kind: 'file' } as never
    ])
    expect(parts).toEqual([{ type: 'text', text: 'hi\n\nAttached file: /no/such.png\nAttached file: /tmp/notes.txt' }])
    expect(await turnInput('plain')).toEqual([{ type: 'text', text: 'plain' }])
  })
})

const item = (over: Record<string, unknown>) => ({ itemId: 'i1', revision: 1, status: 'inProgress', kind: 'toolCall', ...over }) as never

describe('items', () => {
  it('a tool call starts a row titled by the CLI and settles with its output and exit', () => {
    const tool = item({ tool: 'shell', callId: 'c1', commandText: 'ls -la', displayLabel: { active: 'Running ls -la', done: 'Ran' } })
    expect(foldItem('started', tool)).toEqual([{ type: 'tool.started', callId: 'c1', title: 'Running ls -la', kind: 'execute', input: { command: 'ls -la' } }])
    expect(foldItem('completed', item({ tool: 'shell', callId: 'c1', commandText: 'ls -la', status: 'completed', exitCode: 0 }), 'total 0\n')).toEqual([
      { type: 'tool.updated', callId: 'c1', title: 'shell: ls -la', kind: 'execute', status: 'completed', detail: 'total 0\n' }
    ])
    expect(foldItem('completed', item({ tool: 'shell', callId: 'c1', commandText: 'x', status: 'failed', exitCode: 2 }), '')[0]).toMatchObject({ status: 'failed', detail: 'exit 2' })
    expect(foldItem('completed', item({ tool: 'shell', callId: 'c1', status: 'rejected' }))[0]).toMatchObject({ status: 'failed' })
    expect(toolTitle(item({ kind: 'subagent', objective: 'review' }))).toBe('Subagent')
    // 1.4.14's bash tool: the command in the JSON args, the final visibleOutput a receipt
    const bash = item({ tool: 'bash', callId: 'c2', args: '{"command":"ls -la","description":"List"}' })
    expect(foldItem('started', bash)).toEqual([{ type: 'tool.started', callId: 'c2', title: 'bash: ls -la', kind: 'execute', input: { command: 'ls -la' } }])
    const receipt = JSON.stringify({ chunk_id: 'exec-1-1', command: 'ls -la', exit_code: 2, terminal_status: 'completed', output: 'total 16\n', truncated: false })
    expect(foldItem('completed', item({ tool: 'bash', callId: 'c2', args: '{"command":"ls -la"}', status: 'completed', visibleOutput: receipt }))[0]).toMatchObject({ status: 'completed', detail: 'total 16\n\nexit 2' })
    expect(foldItem('started', item({ kind: 'hookRun', hookKey: 'pre' }))[0]).toMatchObject({ type: 'tool.started', title: 'Hook', callId: 'i1' })
  })

  it('messages and reasoning close their blocks; the rest fold to nothing', () => {
    expect(foldItem('started', item({ kind: 'agentMessage' }))).toEqual([])
    expect(foldItem('completed', item({ kind: 'agentMessage', status: 'completed' }))).toEqual([{ type: 'message.completed' }])
    expect(foldItem('completed', item({ kind: 'reasoning', status: 'completed' }))).toEqual([{ type: 'reasoning.completed' }])
    expect(foldItem('completed', item({ kind: 'userMessage', status: 'completed' }))).toEqual([])
    expect(foldItem('completed', item({ kind: 'compaction', status: 'completed' }))).toEqual([])
  })

  it('deltas: a message text streams, a reasoning summary thinks, a tool output is kept aside', () => {
    const d = (over: Record<string, unknown>) => ({ sessionId: 's', itemId: 'i1', viewCursor: 'v', delta: 'x', ...over })
    expect(foldDelta('agentMessage', d({ field: 'text' }))).toEqual({ type: 'message.delta', text: 'x' })
    expect(foldDelta('agentMessage', d({}))).toEqual({ type: 'message.delta', text: 'x' })
    expect(foldDelta('reasoning', d({ field: 'summary.0' }))).toEqual({ type: 'reasoning.delta', text: 'x' })
    expect(foldDelta('toolCall', d({ field: 'output' }))).toBeNull()
    expect(foldDelta(undefined, d({}))).toBeNull()
  })
})

describe('approvals and questions', () => {
  const request = {
    toolName: 'shell',
    subject: { kind: 'shell', command: 'rm -rf build' },
    availableChoices: [
      { choiceId: 'c-session', decision: 'approvedForSession', label: 'Allow for this session', scope: 'session' },
      { choiceId: 'c-once', decision: 'approved', label: 'Allow once', scope: 'once' },
      { choiceId: 'c-amend', decision: 'deniedPolicyAmendment', label: 'Never', scope: 'localPersistent' },
      { choiceId: 'c-abort', decision: 'abort', label: 'Stop', scope: 'once' }
    ]
  } as never
  it('picks the once-only approved choice for allow, denied else abort for deny, never an amendment', () => {
    expect(approvalChoice(request, true)?.choiceId).toBe('c-once')
    expect(approvalChoice(request, false)?.choiceId).toBe('c-abort')
    expect(approvalChoice({ availableChoices: [] }, true)).toBeNull()
    expect(approvalTitle(request)).toBe('rm -rf build')
    expect(approvalTitle({ toolName: 'read', subject: { kind: 'path', path: '/etc/hosts' } } as never)).toBe('path: /etc/hosts')
  })

  const q = {
    questions: [
      { id: 'q1', header: 'Indent', question: 'Tabs or spaces?', selection: { mode: 'single', maxSelections: 1 }, options: [{ label: 'Tabs' }, { label: 'Spaces', description: 'two' }] },
      { id: 'q2', header: '', question: 'Which files?', selection: { mode: 'multiple', maxSelections: 3 }, options: [{ label: 'a' }, { label: 'b' }] }
    ]
  } as never
  it('questions take the card shape and answers go back by label or as free text', () => {
    expect(questionsOf(q)).toEqual([
      { question: 'Tabs or spaces?', header: 'Indent', multiSelect: false, allowFreeform: true, options: [{ label: 'Tabs' }, { label: 'Spaces', description: 'two' }] },
      { question: 'Which files?', header: undefined, multiSelect: true, allowFreeform: true, options: [{ label: 'a' }, { label: 'b' }] }
    ])
    expect(answersOf(q, [['Spaces'], ['a', 'b', 'also c']])).toEqual([
      { questionId: 'q1', selectedLabel: 'Spaces' },
      { questionId: 'q2', selectedLabels: ['a', 'b'], freeText: 'also c' }
    ])
    expect(answersOf(q, [['four please']])).toEqual([{ questionId: 'q1', freeText: 'four please' }, { questionId: 'q2' }])
  })
})

describe("the host's arguments", () => {
  it('disables the sandbox only on a Linux host that says it is unavailable', () => {
    expect(serveArgs('linux', { sandboxAvailability: 'unavailable' })).toEqual(['--disable-sandbox'])
    expect(serveArgs('linux', { sandboxAvailability: 'available' })).toEqual([])
    expect(serveArgs('darwin', { sandboxAvailability: 'unavailable' })).toEqual([])
    expect(serveArgs('linux', {})).toEqual([])
  })
})

describe("the turn's end", () => {
  it('words a quota stop as a resetting limit, a missing login as the sign-in line, a cancel as nothing', () => {
    const at = Date.now() + 90 * 60_000
    expect(turnError({ terminal: 'failed', error: { kind: 'modelError', message: 'limit', retryable: false, quota: { limitKind: 'tierLimit', resetsAtMs: at } } })).toBe('quota: tierLimit, resets in 1 h 30 min (limit)')
    expect(turnError({ terminal: 'failed', error: { kind: 'authRequired', message: 'x', retryable: false } })).toMatch(/not logged in on this host: run `muse login`/)
    expect(turnError({ terminal: 'failed', error: { kind: 'configError', message: 'bad hooks', retryable: false } })).toBe('Muse Code config error: bad hooks')
    expect(turnError({ terminal: 'failed', error: { kind: 'stepLimit', message: '', retryable: false } })).toBe('turn ended: step limit')
    expect(turnError({ terminal: 'cancelled' })).toBeNull()
    expect(turnError({ terminal: 'completed' })).toBeNull()
    expect(turnError({ terminal: 'failed' })).toBe('the turn failed')
    expect(resetWords(Date.now() + 5 * 60_000)).toBe('in 5 min')
    expect(retryWords(2, 5, 32_000, 503)).toBe('retry 2 of 5 in 32 s (503)')
  })
})
