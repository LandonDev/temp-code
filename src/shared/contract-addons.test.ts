import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from './contract'
import { METHOD_CAPABILITY } from './capabilities'
import { AddonInputSchema, AddonRowSchema, AddonSpecSchema } from './contract-addons'
import { SkillFileSchema, SkillInputSchema } from './contract-skills'

const person = { kind: 'person' } as const
const stdio = { transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: ['GITHUB_TOKEN'], auth: 'fields' } as const
const row = { id: 'ad_1', name: 'github', workspaceId: null, description: 'GitHub', spec: stdio, enabled: true, addedBy: person, writtenBy: person, createdAt: 1, updatedAt: 1 }
const skillInput = { name: 'tidy', workspaceId: 'ws1', files: [{ path: 'SKILL.md', text: '---\nname: tidy\n---' }, { path: 'bin.dat', base64: 'AAEC', executable: true }] }

const REQUESTS: { method: string; params?: unknown }[] = [
  { method: 'addons.list' },
  { method: 'addons.list', params: { workspaceId: 'ws1' } },
  { method: 'addons.list', params: { workspaceId: null } },
  { method: 'addons.set', params: { addon: { name: 'github', workspaceId: null, spec: stdio } } },
  { method: 'addons.set', params: { addon: { ...row } } },
  { method: 'addons.remove', params: { id: 'ad_1' } },
  { method: 'addons.tools', params: { id: 'ad_1' } },
  { method: 'skills.list' },
  { method: 'skills.list', params: { workspaceId: 'ws1' } },
  { method: 'skills.get', params: { id: 'sk_1' } },
  { method: 'skills.set', params: { skill: skillInput } },
  { method: 'skills.set', params: { skill: { ...skillInput, id: 'sk_1', harnesses: ['claude'], enabled: false, addedBy: person, writtenBy: person } } },
  { method: 'skills.remove', params: { id: 'sk_1' } },
  { method: 'app.addonList', params: { sessionId: 's' } },
  { method: 'app.addonAdd', params: { sessionId: 's', name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth', scope: 'global' } },
  { method: 'app.addonRemove', params: { sessionId: 's', name: 'linear' } },
  { method: 'app.addonFind', params: { sessionId: 's', query: 'issue' } },
  { method: 'app.addonCall', params: { sessionId: 's', tool: 'linear__create_issue', arguments: { title: 'x' } } },
  { method: 'app.skillList', params: { sessionId: 's' } },
  { method: 'app.skillWrite', params: { sessionId: 's', name: 'tidy', harnesses: ['all'], files: [{ path: 'SKILL.md', text: 'x' }] } },
  { method: 'app.skillWrite', params: { sessionId: 's', name: 'tidy', dir: '/tmp/tidy', scope: 'global' } },
  { method: 'app.skillRemove', params: { sessionId: 's', name: 'tidy', scope: 'workspace' } }
]

describe('the add-on and skill contract', () => {
  it('parses every request through ClientRequestSchema', () => {
    for (const req of REQUESTS) {
      const parsed = ClientRequestSchema.safeParse({ id: '1', ...req })
      expect(parsed.success, `${req.method} ${JSON.stringify(req.params)}: ${parsed.error?.message}`).toBe(true)
    }
  })

  it('gives every method its capability: reads read, writes admin, the bridge local', () => {
    expect(METHOD_CAPABILITY['addons.list']).toBe('read')
    expect(METHOD_CAPABILITY['addons.tools']).toBe('read')
    expect(METHOD_CAPABILITY['skills.list']).toBe('read')
    expect(METHOD_CAPABILITY['skills.get']).toBe('read')
    for (const m of ['addons.set', 'addons.remove', 'skills.set', 'skills.remove'] as const) expect(METHOD_CAPABILITY[m], m).toBe('admin')
    for (const m of ['app.addonList', 'app.addonAdd', 'app.addonRemove', 'app.addonFind', 'app.addonCall', 'app.skillList', 'app.skillWrite', 'app.skillRemove'] as const) {
      expect(METHOD_CAPABILITY[m], m).toBe('local')
    }
  })

  it('refuses a spec or a row the schema cannot hold', () => {
    expect(AddonSpecSchema.safeParse({ ...stdio, env: ['1BAD'] }).success).toBe(false)
    expect(AddonSpecSchema.safeParse({ transport: 'http', url: 'not a url', headers: [], auth: 'none' }).success).toBe(false)
    expect(AddonSpecSchema.safeParse({ transport: 'http', url: 'https://x.dev', headers: ['Bad Header'], auth: 'none' }).success).toBe(false)
    expect(AddonSpecSchema.safeParse({ ...stdio, platforms: [] }).success).toBe(false)
    expect(AddonRowSchema.safeParse({ ...row, name: 'GitHub' }).success).toBe(false)
    expect(AddonInputSchema.parse({ name: 'github', workspaceId: null, spec: stdio }).enabled).toBeUndefined()
  })

  it('a skill file carries text or base64, never both or neither', () => {
    expect(SkillFileSchema.safeParse({ path: 'a', text: 'x' }).success).toBe(true)
    expect(SkillFileSchema.safeParse({ path: 'a', base64: 'AA==' }).success).toBe(true)
    expect(SkillFileSchema.safeParse({ path: 'a', text: 'x', base64: 'AA==' }).success).toBe(false)
    expect(SkillFileSchema.safeParse({ path: 'a' }).success).toBe(false)
    expect(SkillInputSchema.safeParse({ ...skillInput, files: [] }).success).toBe(false)
    expect(SkillInputSchema.safeParse({ ...skillInput, harnesses: [] }).success).toBe(false)
  })
})
