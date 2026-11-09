import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HTML_PREVIEW_TOOL_DESCRIPTION,
  HTML_RENDER_TOOL_DESCRIPTION,
  HTML_TOOL_PARAMS
} from '@shared/htmlRender'
import { CITE_TOOL_DESCRIPTION, CITE_TOOL_PARAMS } from '@shared/research'
import { UPDATE_NOTES_DESCRIPTION, UPDATE_NOTES_PARAMS, UPDATE_NOTES_TOOL_NAME } from '@shared/notes'
import { ThreadTypeSchema } from '@shared/domain'
import { NOTE_DECISION_DESCRIPTION, NOTE_DECISION_PARAMS, NOTE_DECISION_TOOL_NAME } from '@shared/away'
import {
  ADOPT_THREAD_PARAMS,
  ADOPT_THREAD_TOOL_DESCRIPTION,
  ADOPT_THREAD_TOOL_NAME,
  ARCHIVE_THREADS_PARAMS,
  ARCHIVE_THREADS_TOOL_DESCRIPTION,
  ARCHIVE_THREADS_TOOL_NAME,
  BATCH_GATE_PARAMS,
  BATCH_GATE_TOOL_DESCRIPTION,
  BATCH_GATE_TOOL_NAME,
  BATCH_RULES_PARAMS,
  BATCH_RULES_TOOL_DESCRIPTION,
  BATCH_RULES_TOOL_NAME
} from '@shared/gate'
import { NOTE_DECISION_SHAPE, SKILL_REMOVE_SHAPE, SKILL_WRITE_SHAPE, ADOPT_THREAD_SHAPE, ARCHIVE_THREADS_SHAPE, BATCH_GATE_SHAPE, BATCH_RULES_SHAPE, CITE_SHAPE, HTML_PREVIEW_SHAPE, HTML_RENDER_SHAPE, MERGE_BRANCH_SHAPE, REPORT_FINDINGS_SHAPE } from './apptools'
import * as addons from '@shared/addons'
import { bridgeMcpConfig, setAppAddons, setAppBridge } from './apptools'
import {
  MERGE_BRANCH_PARAMS,
  MERGE_BRANCH_TOOL_DESCRIPTION,
  REPORT_FINDINGS_PARAMS,
  REPORT_FINDINGS_TOOL_DESCRIPTION,
  REVIEW_FINDING_PARAMS
} from '@shared/review'
import {
  SKILL_LIST_DESCRIPTION,
  SKILL_LIST_TOOL,
  SKILL_REMOVE_DESCRIPTION,
  SKILL_REMOVE_PARAMS,
  SKILL_REMOVE_TOOL,
  SKILL_WRITE_DESCRIPTION,
  SKILL_WRITE_PARAMS,
  SKILL_WRITE_TOOL
} from '@shared/skills'

const bridgePath = join(import.meta.dirname, '..', '..', '..', 'scripts', 'app-mcp-bridge.mjs')

type BridgeTool = {
  name: string
  description: string
  inputSchema: {
    properties: Record<string, { description?: string }>
    required?: string[]
  }
}

const bridge = (await import(bridgePath)) as {
  TOOLS: BridgeTool[]
  METHOD_FOR: Record<string, string>
  clientTimeoutMs: (name: string, args?: unknown) => number
  toolContent: (name: string, result: unknown) => Array<Record<string, unknown>>
}

describe('app-mcp-bridge cite_source and thread types', () => {
  it("the bridge's cite_source matches the shared description and params", () => {
    const cite = bridge.TOOLS.find((t) => t.name === 'cite_source')!
    expect(cite.description).toBe(CITE_TOOL_DESCRIPTION)
    expect(Object.keys(cite.inputSchema.properties)).toEqual(Object.keys(CITE_SHAPE))
    expect(cite.inputSchema.required).toEqual(['url', 'claim'])
    for (const [name, schema] of Object.entries(cite.inputSchema.properties)) {
      expect(schema.description).toBe(CITE_TOOL_PARAMS[name as keyof typeof CITE_TOOL_PARAMS])
    }
  })

  it('the bridge lists plan_complete for planning and project-plan threads', () => {
    const tool = bridge.TOOLS.find((t) => t.name === 'plan_complete')!
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['summary'])
    expect(tool.description).toContain('project plan gets `status: complete`')
  })

  it('app_start_thread offers every thread type, research included', () => {
    const start = bridge.TOOLS.find((t) => t.name === 'app_start_thread')!
    const threadType = start.inputSchema.properties.threadType as { enum?: string[] }
    expect(threadType.enum).toEqual(ThreadTypeSchema.options)
  })
})

describe('app-mcp-bridge update_notes', () => {
  it('carries the shared description and parameter texts', () => {
    const tool = bridge.TOOLS.find((t) => t.name === UPDATE_NOTES_TOOL_NAME)!
    expect(tool.description).toBe(UPDATE_NOTES_DESCRIPTION)
    const props = tool.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>
    expect(props.section.description).toBe(UPDATE_NOTES_PARAMS.section)
    expect(props.mode.description).toBe(UPDATE_NOTES_PARAMS.mode)
    expect(props.mode.enum).toEqual(['replace', 'append'])
    expect(props.content.description).toBe(UPDATE_NOTES_PARAMS.content)
    expect(tool.inputSchema.required).toEqual(['section', 'content'])
  })
})

describe('app-mcp-bridge note_decision', () => {
  it('carries the shared description and parameter text', () => {
    const tool = bridge.TOOLS.find((t) => t.name === NOTE_DECISION_TOOL_NAME)!
    expect(tool.description).toBe(NOTE_DECISION_DESCRIPTION)
    expect(Object.keys(tool.inputSchema.properties)).toEqual(Object.keys(NOTE_DECISION_SHAPE))
    expect(tool.inputSchema.properties.decision.description).toBe(NOTE_DECISION_PARAMS.decision)
    expect(tool.inputSchema.required).toEqual(['decision'])
  })
})

describe('app-mcp-bridge html tools', () => {
  it("the bridge's descriptions equal the shared constants and its schemas name the same params", () => {
    const preview = bridge.TOOLS.find((t) => t.name === 'html_preview')!
    const render = bridge.TOOLS.find((t) => t.name === 'html_render')!
    expect(preview.description).toBe(HTML_PREVIEW_TOOL_DESCRIPTION)
    expect(render.description).toBe(HTML_RENDER_TOOL_DESCRIPTION)
    expect(Object.keys(preview.inputSchema.properties)).toEqual(Object.keys(HTML_PREVIEW_SHAPE))
    expect(Object.keys(render.inputSchema.properties)).toEqual(Object.keys(HTML_RENDER_SHAPE))
    expect(preview.inputSchema.required).toEqual(['html'])
    expect(render.inputSchema.required).toEqual(['html', 'title', 'height'])
    for (const tool of [preview, render]) {
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        expect(schema.description).toBe(HTML_TOOL_PARAMS[name as keyof typeof HTML_TOOL_PARAMS])
      }
    }
  })

  it('passes the preview PNG through as an image part and everything else as text', () => {
    const parts = bridge.toolContent('html_preview', {
      png: 'UE5H',
      width: 864,
      contentHeight: 10,
      capturedHeight: 10,
      consoleMessages: []
    })
    expect(parts).toEqual([
      { type: 'text', text: JSON.stringify({ width: 864, contentHeight: 10, capturedHeight: 10, consoleMessages: [] }) },
      { type: 'image', data: 'UE5H', mimeType: 'image/png' }
    ])
    expect(bridge.toolContent('html_render', { htmlRender: { pageId: 'p' }, message: 'm' })).toEqual([
      { type: 'text', text: '{"htmlRender":{"pageId":"p"},"message":"m"}' }
    ])
    expect(bridge.toolContent('app_read_thread', 'digest')).toEqual([{ type: 'text', text: 'digest' }])
  })
})

describe('app-mcp-bridge merge_branch and report_findings', () => {
  it("the bridge's merge_branch matches the shared description and params", () => {
    const t = bridge.TOOLS.find((x) => x.name === 'merge_branch')!
    expect(t.description).toBe(MERGE_BRANCH_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(MERGE_BRANCH_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(MERGE_BRANCH_PARAMS[name as keyof typeof MERGE_BRANCH_PARAMS])
    }
  })

  it("the bridge's report_findings matches the shared description, params and finding fields", () => {
    const t = bridge.TOOLS.find((x) => x.name === 'report_findings')!
    expect(t.description).toBe(REPORT_FINDINGS_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(REPORT_FINDINGS_SHAPE))
    expect(t.inputSchema.required).toEqual(['findings'])
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(REPORT_FINDINGS_PARAMS[name as keyof typeof REPORT_FINDINGS_PARAMS])
    }
    const items = (t.inputSchema.properties.findings as { items: BridgeTool['inputSchema'] }).items
    expect(Object.keys(items.properties)).toEqual(Object.keys(REVIEW_FINDING_PARAMS))
    expect(items.required).toEqual(['file', 'summary', 'failure_scenario'])
    for (const [name, schema] of Object.entries(items.properties)) {
      expect(schema.description).toBe(REVIEW_FINDING_PARAMS[name as keyof typeof REVIEW_FINDING_PARAMS])
    }
  })
})

describe('app-mcp-bridge batch_rules', () => {
  it("the bridge's batch_rules matches the shared description and params, and maps to app.batchRules", () => {
    const t = bridge.TOOLS.find((x) => x.name === BATCH_RULES_TOOL_NAME)!
    expect(t.description).toBe(BATCH_RULES_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(BATCH_RULES_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(BATCH_RULES_PARAMS[name as keyof typeof BATCH_RULES_PARAMS])
    }
  })
})

describe('app-mcp-bridge adopt_thread', () => {
  it("the bridge's adopt_thread matches the shared description and params, and maps to app.adoptThread", () => {
    const t = bridge.TOOLS.find((x) => x.name === ADOPT_THREAD_TOOL_NAME)!
    expect(t.description).toBe(ADOPT_THREAD_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(ADOPT_THREAD_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(ADOPT_THREAD_PARAMS[name as keyof typeof ADOPT_THREAD_PARAMS])
    }
  })
})

describe('app-mcp-bridge archive_threads', () => {
  it("the bridge's archive_threads matches the shared description and params, and maps to app.archiveThreads", () => {
    const t = bridge.TOOLS.find((x) => x.name === ARCHIVE_THREADS_TOOL_NAME)!
    expect(t.description).toBe(ARCHIVE_THREADS_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(ARCHIVE_THREADS_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(ARCHIVE_THREADS_PARAMS[name as keyof typeof ARCHIVE_THREADS_PARAMS])
    }
  })
})

describe('app-mcp-bridge batch_gate', () => {
  it("the bridge's batch_gate matches the shared description and params, and maps to app.batchGate", () => {
    const t = bridge.TOOLS.find((x) => x.name === BATCH_GATE_TOOL_NAME)!
    expect(t.description).toBe(BATCH_GATE_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(BATCH_GATE_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(BATCH_GATE_PARAMS[name as keyof typeof BATCH_GATE_PARAMS])
    }
  })
})

describe('app-mcp-bridge skill tools', () => {
  it('copies the shared words, maps each to its app.skill* method and waits on a card with no client deadline', () => {
    const list = bridge.TOOLS.find((x) => x.name === SKILL_LIST_TOOL)!
    expect(list.description).toBe(SKILL_LIST_DESCRIPTION)
    expect(Object.keys(list.inputSchema.properties)).toEqual([])
    const write = bridge.TOOLS.find((x) => x.name === SKILL_WRITE_TOOL)!
    expect(write.description).toBe(SKILL_WRITE_DESCRIPTION)
    expect(Object.keys(write.inputSchema.properties)).toEqual(Object.keys(SKILL_WRITE_SHAPE))
    for (const [name, schema] of Object.entries(write.inputSchema.properties)) expect(schema.description).toBe(SKILL_WRITE_PARAMS[name as keyof typeof SKILL_WRITE_PARAMS])
    expect(write.inputSchema.required).toEqual(['name'])
    const remove = bridge.TOOLS.find((x) => x.name === SKILL_REMOVE_TOOL)!
    expect(remove.description).toBe(SKILL_REMOVE_DESCRIPTION)
    expect(Object.keys(remove.inputSchema.properties)).toEqual(Object.keys(SKILL_REMOVE_SHAPE))
    for (const [name, schema] of Object.entries(remove.inputSchema.properties)) expect(schema.description).toBe(SKILL_REMOVE_PARAMS[name as keyof typeof SKILL_REMOVE_PARAMS])
    expect([bridge.METHOD_FOR.skill_list, bridge.METHOD_FOR.skill_write, bridge.METHOD_FOR.skill_remove]).toEqual(['app.skillList', 'app.skillWrite', 'app.skillRemove'])
    expect([bridge.clientTimeoutMs('skill_write'), bridge.clientTimeoutMs('skill_remove'), bridge.clientTimeoutMs('skill_list')]).toEqual([0, 0, 120_000])
  })
})

describe('app-mcp-bridge add-on tools', () => {
  type Listed = BridgeTool[]
  const addonBridge = bridge as unknown as {
    ADDON_TOOLS: Listed
    ADDON_CALL_TOOLS: Listed
    listedTools: (macToken?: string, addons?: boolean) => Listed
    METHOD_FOR: Record<string, string>
    clientTimeoutMs: (name: string, args?: unknown) => number
    toolResult: (name: string, result: unknown) => Record<string, unknown>
  }
  const byName = (name: string) => [...addonBridge.ADDON_TOOLS, ...addonBridge.ADDON_CALL_TOOLS].find((t) => t.name === name)!
  const same = (name: string, description: string, params: Record<string, string>) => {
    const t = byName(name)
    expect(t.description).toBe(description)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(params))
    for (const [key, schema] of Object.entries(t.inputSchema.properties)) expect(schema.description).toBe(params[key])
  }

  it("carries the shared words of every add-on tool", () => {
    expect(byName(addons.ADDON_LIST_TOOL).description).toBe(addons.ADDON_LIST_DESCRIPTION)
    same(addons.ADDON_ADD_TOOL, addons.ADDON_ADD_DESCRIPTION, addons.ADDON_ADD_PARAMS)
    same(addons.ADDON_REMOVE_TOOL, addons.ADDON_REMOVE_DESCRIPTION, addons.ADDON_REMOVE_PARAMS)
    same(addons.ADDON_FIND_TOOL, addons.ADDON_FIND_DESCRIPTION, addons.ADDON_FIND_PARAMS)
    same(addons.ADDON_CALL_TOOL, addons.ADDON_CALL_DESCRIPTION, addons.ADDON_CALL_PARAMS)
  })

  it('lists addon_find and addon_call only with add-ons in scope, the management tools always', () => {
    const names = (addonsOn: boolean) => addonBridge.listedTools(undefined, addonsOn).map((t) => t.name)
    expect(names(false)).toEqual(expect.arrayContaining(['addon_list', 'addon_add', 'addon_remove']))
    expect(names(false)).not.toContain('addon_find')
    expect(names(false)).not.toContain('addon_call')
    expect(names(true)).toEqual(expect.arrayContaining(['addon_find', 'addon_call']))
  })

  it('maps each tool to its app method, waits on the server for add, remove and call, and passes a call through whole', () => {
    expect(addonBridge.METHOD_FOR).toMatchObject({
      addon_list: 'app.addonList',
      addon_add: 'app.addonAdd',
      addon_remove: 'app.addonRemove',
      addon_find: 'app.addonFind',
      addon_call: 'app.addonCall'
    })
    expect(['addon_add', 'addon_remove', 'addon_call', 'addon_list', 'addon_find'].map((n) => addonBridge.clientTimeoutMs(n))).toEqual([0, 0, 0, 120_000, 120_000])
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    expect(addonBridge.toolResult('addon_call', { content: [image], isError: true, structuredContent: { ok: false } })).toEqual({
      content: [image],
      isError: true,
      structuredContent: { ok: false }
    })
    expect(addonBridge.toolResult('addon_call', { content: [{ type: 'text', text: 'x' }] })).toEqual({ content: [{ type: 'text', text: 'x' }] })
    expect(addonBridge.toolResult('addon_list', '[]\nnote')).toEqual({ content: [{ type: 'text', text: '[]\nnote' }] })
  })

  it('bridgeMcpConfig sets TEMP_CODE_ADDONS while the thread\'s scope holds an add-on', () => {
    setAppBridge({ port: 1, scriptPath: '/x.mjs', command: 'node', env: {} })
    const hooks = { exposure: { attach: () => () => {} }, list: () => '', add: async () => '', remove: async () => '' }
    try {
      setAppAddons({ ...hooks, hasAddons: (id) => id === 'with' })
      expect((bridgeMcpConfig('with')!.env as Record<string, string>).TEMP_CODE_ADDONS).toBe('1')
      expect((bridgeMcpConfig('without')!.env as Record<string, string>).TEMP_CODE_ADDONS).toBeUndefined()
    } finally {
      setAppAddons(null)
      setAppBridge(null)
    }
  })
})
