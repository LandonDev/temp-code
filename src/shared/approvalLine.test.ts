import { describe, expect, it } from 'vitest'
import { approvalLine } from './approvalLine'

describe('approvalLine for MCP tools', () => {
  it('reads an add-on tool on the app server as its tool from its add-on', () => {
    expect(approvalLine('mcp__app__github__create_issue', { title: 'x' })).toBe('Use create_issue from github?')
    expect(approvalLine('mcp__app__my-tools__a__b', {})).toBe('Use a__b from my-tools?')
  })

  it('keeps the words of the app\'s own tools and other servers', () => {
    expect(approvalLine('mcp__app__app_start_thread', {})).toBe('Use app?')
    expect(approvalLine('mcp__linear__create_issue', {})).toBe('Use linear?')
  })

  it('takes the card\'s own title first, as the bridge raises it', () => {
    expect(approvalLine('fake__echo', { text: 'hi' }, 'Use echo from fake')).toBe('Use echo from fake?')
  })
})
