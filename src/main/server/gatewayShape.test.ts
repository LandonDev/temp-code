import { afterEach, describe, expect, it, vi } from 'vitest'
import * as zlib from 'node:zlib'
import { decoded, requestShape, shapeEnabled, shapeLaneOf, shapeLine, startShape, UsageTap } from './gatewayShape'

const claudeMd = 'Contents of /srv/agents/work/temp-code/CLAUDE.md (project instructions, checked into the codebase):\n\n# temp-code\n' + 'x'.repeat(2000) + '\n'
const userMd = 'Contents of /home/u/.claude/CLAUDE.md (user\'s private global instructions for all projects):\n\n# mine\n' + 'y'.repeat(300) + '\n'
const reminder = `<system-reminder>\nCodebase and user instructions are shown below.\n\n${userMd}\n${claudeMd}</system-reminder>`

const anthropicBody = JSON.stringify({
  model: 'claude-opus-5-5',
  system: [{ type: 'text', text: 'You are Claude Code.' }, { type: 'text', text: 'Mechanics '.repeat(50) }],
  tools: [
    { name: 'Bash', description: 'd'.repeat(900), input_schema: {} },
    { name: 'mcp__app__update_notes', description: 'notes', input_schema: {} },
    { name: 'mcp__claude_ai_Gmail__search', description: 'g', input_schema: {}, defer_loading: true }
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: reminder }, { type: 'text', text: 'Reply with ok.' }] }]
})

describe('requestShape: anthropic', () => {
  it('splits a system-reminder on its Contents of headings', () => {
    const shape = requestShape(anthropicBody, 'anthropic')!
    const names = shape.parts.map((p) => p.name)
    expect(names).toEqual(['system:0', 'system:1', 'file:/home/u/.claude/CLAUDE.md', 'file:/srv/agents/work/temp-code/CLAUDE.md', 'reminder:0', 'user:1:text'])
    const project = shape.parts.find((p) => p.name === 'file:/srv/agents/work/temp-code/CLAUDE.md')!
    expect(project.bytes).toBe(Buffer.byteLength(claudeMd))
    // Every byte of the reminder lands in exactly one part.
    const reminderBytes = shape.parts.filter((p) => p.name.startsWith('file:') || p.name.startsWith('reminder:')).reduce((n, p) => n + p.bytes, 0)
    expect(reminderBytes).toBe(Buffer.byteLength(reminder))
    expect(shape.model).toBe('claude-opus-5-5')
  })

  it('counts tools, the deferred ones and groups MCP servers', () => {
    const { tools } = requestShape(anthropicBody, 'anthropic')!
    expect(tools.count).toBe(3)
    expect(tools.deferred).toBe(1)
    expect(tools.largest[0].name).toBe('Bash')
    expect(Object.keys(tools.groups).sort()).toEqual(['builtin', 'mcp:app', 'mcp:claude_ai_Gmail'])
  })
})

describe('requestShape: responses', () => {
  it('groups tools by MCP server and namespace and input by role and type', () => {
    const body = JSON.stringify({
      model: 'gpt-6.1-sol',
      instructions: 'i'.repeat(100),
      tools: [
        { type: 'function', name: 'exec_command', parameters: {} },
        { type: 'function', name: 'mcp__linear__list_issues', parameters: {} },
        { type: 'function', name: 'mcp__linear__get_issue', parameters: {} },
        { type: 'function', name: 'search', namespace: 'github', parameters: {} },
        { type: 'mcp', server_label: 'mobbin' },
        { type: 'web_search' }
      ],
      input: [
        { type: 'message', role: 'developer', content: 'dev' },
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'user', content: 'again' }
      ]
    })
    const shape = requestShape(body, 'responses')!
    expect(shape.tools.count).toBe(6)
    expect(Object.keys(shape.tools.groups).sort()).toEqual(['builtin', 'github', 'mcp:linear', 'mcp:mobbin', 'web_search'])
    expect(shape.parts.map((p) => p.name)).toEqual(['instructions', 'input:developer:message', 'input:user:message'])
  })

  it('names every other field and counts the body in bytes', () => {
    const body = JSON.stringify({ model: 'gpt-6.1-sol', input: [], tools: [], reasoning: { effort: 'low' }, include: ['x'] })
    const shape = requestShape(Buffer.from(body), 'responses')!
    expect(shape.bytes).toBe(Buffer.byteLength(body))
    expect(shape.parts.map((p) => p.name)).toEqual(['field:reasoning', 'field:include'])
  })

  it('reads a body that is no JSON as nothing', () => {
    expect(requestShape('not json', 'responses')).toBeNull()
  })
})

describe('UsageTap', () => {
  it('reads message_start across chunk boundaries', () => {
    const tap = new UsageTap()
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":100,"cache_creation_input_tokens":167400}}}\n\n'
    tap.feed(sse.slice(0, 40))
    tap.feed(sse.slice(40))
    expect(tap.usage).toEqual({ input: 167503, cacheRead: 100, cacheCreation: 167400 })
  })

  it('reads response.completed, whose input already holds the cached tokens', () => {
    const tap = new UsageTap()
    tap.feed('event: response.created\ndata: {"type":"response.created"}\n\n')
    tap.feed('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":309125,"input_tokens_details":{"cached_tokens":300000}}}}\n\n')
    expect(tap.usage).toEqual({ input: 309125, cacheRead: 300000, cacheCreation: 0 })
  })

  it('reads a JSON answer at its end', () => {
    const tap = new UsageTap()
    tap.feed('{"usage":{"input_tokens":12,')
    tap.feed('"output_tokens":1}}')
    expect(tap.usage).toBeNull()
    tap.end()
    expect(tap.usage?.input).toBe(12)
  })
})

describe('decoded', () => {
  it('reads a compressed body as its content-encoding says', () => {
    const body = Buffer.from('{"model":"m"}')
    expect(decoded(zlib.gzipSync(body), 'gzip')?.toString()).toBe('{"model":"m"}')
    expect(decoded(zlib.brotliCompressSync(body), 'br')?.toString()).toBe('{"model":"m"}')
    const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync
    if (zstd) expect(decoded(zstd(body), 'zstd')?.toString()).toBe('{"model":"m"}')
    expect(decoded(body, undefined)).toBe(body)
    expect(decoded(body, 'compress')).toBeNull()
  })
})

describe('startShape', () => {
  afterEach(() => vi.restoreAllMocks())

  it('parses nothing without the flag', () => {
    const parse = vi.spyOn(JSON, 'parse')
    expect(startShape(false, '/claude/~t=a;a=b/v1/messages', Buffer.from(anthropicBody))).toBeNull()
    expect(parse).not.toHaveBeenCalled()
  })

  it('parses a known lane with the flag and writes one line', () => {
    const started = startShape(true, '/claude/~t=a;a=b/v1/messages?beta=true', Buffer.from(anthropicBody))!
    expect(started.shape.lane).toBe('anthropic')
    const line = shapeLine('a', started.shape, null, 200)
    expect(line.startsWith('[gateway:shape] {')).toBe(true)
    expect(JSON.parse(line.slice('[gateway:shape] '.length)).thread).toBe('a')
    expect(startShape(true, '/claude/v1/models', Buffer.from('{}'))).toBeNull()
  })

  it('reads the lanes off the path', () => {
    expect(shapeLaneOf('/codex/~t=a;a=b/codex/responses')).toBe('responses')
    expect(shapeLaneOf('/claude/v1/messages/count_tokens')).toBeNull()
  })

  it('is honoured only on an isolated instance', () => {
    expect(shapeEnabled({ TEMP_CODE_GATEWAY_SHAPE: '1' })).toBe(false)
    expect(shapeEnabled({ TEMP_CODE_GATEWAY_SHAPE: '1', TEMP_CODE_USER_DATA: '/tmp/x' })).toBe(true)
  })
})
