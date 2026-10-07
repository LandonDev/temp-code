import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HTML_PREVIEW_TOOL_DESCRIPTION,
  HTML_RENDER_TOOL_DESCRIPTION,
  HTML_TOOL_PARAMS
} from '@shared/htmlRender'
import { CITE_TOOL_DESCRIPTION, CITE_TOOL_PARAMS } from '@shared/research'
import { ThreadTypeSchema } from '@shared/domain'
import { CITE_SHAPE, HTML_PREVIEW_SHAPE, HTML_RENDER_SHAPE } from './apptools'

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

  it('app_start_thread offers every thread type, research included', () => {
    const start = bridge.TOOLS.find((t) => t.name === 'app_start_thread')!
    const threadType = start.inputSchema.properties.threadType as { enum?: string[] }
    expect(threadType.enum).toEqual(ThreadTypeSchema.options)
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
