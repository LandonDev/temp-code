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
import {
  BATCH_GATE_PARAMS,
  BATCH_GATE_TOOL_DESCRIPTION,
  BATCH_GATE_TOOL_NAME,
  BATCH_RULES_PARAMS,
  BATCH_RULES_TOOL_DESCRIPTION,
  BATCH_RULES_TOOL_NAME
} from '@shared/gate'
import { BATCH_GATE_SHAPE, BATCH_RULES_SHAPE, CITE_SHAPE, HTML_PREVIEW_SHAPE, HTML_RENDER_SHAPE, MERGE_BRANCH_SHAPE, REPORT_FINDINGS_SHAPE } from './apptools'
import {
  MERGE_BRANCH_PARAMS,
  MERGE_BRANCH_TOOL_DESCRIPTION,
  REPORT_FINDINGS_PARAMS,
  REPORT_FINDINGS_TOOL_DESCRIPTION,
  REVIEW_FINDING_PARAMS
} from '@shared/review'

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
