import { describe, expect, it } from 'vitest'
import { firstRequest, toolSurface, overheadMarkdown, overheadRows, placeSection, shapeRecords, type ShapeRecord } from './firstRequest'

const record = (over: Partial<ShapeRecord> = {}): ShapeRecord => ({
  thread: 't1',
  status: 200,
  lane: 'anthropic',
  model: 'claude-opus-5-5',
  bytes: 1000,
  parts: [
    { name: 'system:0', bytes: 100 },
    { name: 'system:1', bytes: 50 },
    { name: 'file:/w/temp-code/CLAUDE.md', bytes: 500 },
    { name: 'reminder:0', bytes: 40 },
    { name: 'user:1:text', bytes: 10 }
  ],
  tools: { count: 3, deferred: 1, bytes: 250, largest: [], groups: { builtin: 200, 'mcp:app': 50 } },
  usage: { input: 2000, cacheRead: 0, cacheCreation: 1990 },
  ...over
})

describe('firstRequest', () => {
  it('reads shape lines out of a log and skips a cut one', () => {
    const log = `noise\n[gateway:123] [gateway:shape] ${JSON.stringify(record())}\n[gateway:shape] {cut`
    expect(shapeRecords(log)).toHaveLength(1)
  })

  it('takes the first request on the thread model that carries tools', () => {
    const side = record({ model: 'claude-haiku-5-5', tools: { count: 0, deferred: 0, bytes: 0, largest: [], groups: {} } })
    expect(firstRequest([side, record()], 't1', 'claude-opus-5-5[1m]')?.model).toBe('claude-opus-5-5')
    expect(firstRequest([record()], 't2', 'claude-opus-5-5')).toBeNull()
    // Codex in code mode: its tools ride as an input item, none in `tools`.
    const codex = record({ lane: 'responses', model: 'gpt-6.1-sol', tools: { count: 0, deferred: 0, bytes: 0, largest: [], groups: {} } })
    expect(firstRequest([codex], 't1', 'gpt-6.1-sol')).toBe(codex)
    expect(toolSurface({ ...codex, parts: [{ name: 'input:developer:additional_tools', bytes: 1 }] })).toBe('code mode (additional_tools)')
    expect(toolSurface({ ...codex, tools: { ...codex.tools, count: 90 } })).toBe('inline, 90 tools')
  })

  it('scales each part to the reported input tokens, the framing as its own row', () => {
    const rows = overheadRows(record())
    expect(rows[0]).toMatchObject({ part: 'Project CLAUDE.md', bytes: 500, tokens: 1000 })
    expect(rows.find((r) => r.part === 'System prompt')?.bytes).toBe(150)
    expect(rows.find((r) => r.part === 'JSON framing and settings')?.bytes).toBe(50)
    expect(rows.reduce((n, r) => n + r.bytes, 0)).toBe(1000)
  })

  it('writes the share of the window and replaces a section in place', () => {
    const md = overheadMarkdown({ provider: 'claude', model: 'claude-opus-5-5', record: record(), window: 200_000 })
    expect(md).toContain('2.0k input tokens of a 200.0k window (1.0%)')
    const doc = placeSection('# Doc\n\n## before on the box\n\nold\n\n## after on the box\n\nkeep\n', 'before on the box', 'new')
    expect(doc).toBe('# Doc\n\n## before on the box\n\nnew\n\n## after on the box\n\nkeep\n')
    expect(placeSection('# Doc\n', 'x', 'y')).toBe('# Doc\n\n## x\n\ny\n')
  })
})
