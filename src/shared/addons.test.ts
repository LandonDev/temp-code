import { describe, expect, it } from 'vitest'
import {
  ADDON_ADMIN_LINE,
  ADDON_NAME_RE,
  EXPOSED_NAME_MAX,
  addonCard,
  addonProblem,
  addonRemoveCard,
  approvalNeedsAdmin,
  approverOf,
  assertMayAnswer,
  exposedNames,
  looksSecret,
  mayAllow,
  removeAsks,
  shellQuote,
  visibleRows,
  writerWords
} from './addons'
import type { AddonSpec } from './contract-addons'
import { sha256Hex } from './sha256'

const stdio = (over: Partial<Extract<AddonSpec, { transport: 'stdio' }>> = {}): AddonSpec => ({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: [],
  auth: 'none',
  ...over
})
const http = (over: Partial<Extract<AddonSpec, { transport: 'http' }>> = {}): AddonSpec => ({
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  headers: [],
  auth: 'none',
  ...over
})

describe('sha256', () => {
  it('matches the known digests', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // Two blocks, and a length that pads into a second block.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
  })
})

describe('names and scope', () => {
  it('takes lowercase names that leave room for the tool', () => {
    for (const n of ['github', 'a', 'my-mcp-2', 'x'.repeat(20)]) expect(ADDON_NAME_RE.test(n), n).toBe(true)
    for (const n of ['', 'GitHub', '2fa', '-x', 'a_b', 'x'.repeat(21)]) expect(ADDON_NAME_RE.test(n), n).toBe(false)
  })

  it('a thread sees the global rows and its workspace, the workspace shadowing a global name', () => {
    const rows = [
      { id: 'g1', name: 'github', workspaceId: null },
      { id: 'g2', name: 'linear', workspaceId: null },
      { id: 'w1', name: 'github', workspaceId: 'ws1' },
      { id: 'w2', name: 'figma', workspaceId: 'ws2' }
    ]
    expect(visibleRows(rows, 'ws1').map((r) => r.id)).toEqual(['w1', 'g2'])
    expect(visibleRows(rows, 'ws2').map((r) => r.id)).toEqual(['w2', 'g1', 'g2'])
    expect(visibleRows(rows, null).map((r) => r.id)).toEqual(['g1', 'g2'])
  })

  it('words a writer for a card', () => {
    expect(writerWords({ kind: 'person' })).toBe('You')
    expect(writerWords({ kind: 'person', key: 'Phone' })).toBe('Phone')
    expect(writerWords({ kind: 'thread', sessionId: 's', environmentId: 'e', title: 'Wire GitHub' })).toBe('Wire GitHub')
    expect(writerWords({ kind: 'import', from: '~/.claude/skills/x' })).toBe('Imported')
  })
})

describe('looksSecret', () => {
  it('catches the known token shapes', () => {
    for (const s of [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'sk-proj-ABCDEFGHIJKLMNOPQRSTUV',
      'sk_live_51HxyzABCDEF',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_abcdefghijklmnopqrstuvwxyz0123',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
      'glpat-abcdefghij1234567890',
      'xoxb-123456789012-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyA1234567890abcdefghijklmnopqrstu',
      'ya29.a0AfH6SMBabcdefghijklmnopqrstu',
      'LLM_1607_abc',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig',
      '-----BEGIN PRIVATE KEY-----',
      'https://user:hunter2@example.com/mcp',
      'https://mcp.example.com/sse?token=abc',
      'https://mcp.example.com/sse?x=1&api_key=abc',
      'https://mcp.example.com/sse?apikey=abc',
      '--key=Zx81kQ0pLm2Nb7Vc4Xs9Ta6Yd3We5Rf1Gh',
      'Zx81kQ0pLm2Nb7Vc4Xs9Ta6Yd3We5Rf1Gh0J'
    ]) {
      expect(looksSecret(s), s).toBe(true)
    }
  })

  it('lets package names, paths, flags and plain URLs through', () => {
    for (const s of [
      '-y',
      '@modelcontextprotocol/server-github',
      'mcp-server-sqlite',
      '/Users/me/IdeaProjects/temp-code/node_modules/.bin/some-very-long-mcp-server-name',
      '--stdio',
      'https://mcp.linear.app/sse',
      'https://mcp.example.com/sse?monkey=1&keyboard=2',
      'https://example.com/a/Zx81kQ0pLm2Nb7Vc4Xs9Ta6Yd3We5Rf1Gh',
      '123e4567-e89b-12d3-a456-426614174000',
      'SomeVeryLongCamelCasePackageNameWithNoDigits',
      'sk-learn',
      'task-runner'
    ]) {
      expect(looksSecret(s), s).toBe(false)
    }
  })
})

describe('addonProblem', () => {
  it('passes a plain stdio and http add-on', () => {
    expect(addonProblem(stdio(), 'github')).toBeNull()
    expect(addonProblem(stdio({ auth: 'fields', env: ['GITHUB_TOKEN'] }), 'github')).toBeNull()
    expect(addonProblem(stdio({ auth: 'oauth', tokenEnv: 'ACCESS_TOKEN' }), 'github')).toBeNull()
    expect(addonProblem(http(), 'linear')).toBeNull()
    expect(addonProblem(http({ url: 'http://127.0.0.1:3845/mcp' }), 'figma')).toBeNull()
    expect(addonProblem(http({ url: 'http://localhost:3845/mcp', auth: 'fields', headers: ['X-Api-Key'] }), 'figma')).toBeNull()
  })

  it('names the field a secret sits in', () => {
    expect(addonProblem(stdio({ args: ['-y', 'pkg', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }), 'github')).toBe(
      "args[2] looks like a secret; name the variable in env and its value goes in the add-on's grant"
    )
    expect(addonProblem(stdio({ command: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345' }), 'x')).toMatch(/^command looks like a secret/)
    expect(addonProblem(http({ url: 'https://mcp.example.com/sse?token=abc' }), 'x')).toBe(
      "url looks like a secret; name the header in headers and its value goes in the add-on's grant"
    )
  })

  it('refuses plain http off this machine, a bad name and every inconsistent grant', () => {
    expect(addonProblem(http({ url: 'http://mcp.example.com/mcp' }), 'x')).toBe('url must be https, or plain http to this machine')
    expect(addonProblem(http({ url: 'ftp://example.com/x' }), 'x')).toBe('url must be https, or plain http to this machine')
    expect(addonProblem(stdio(), 'GitHub')).toMatch(/^name takes lowercase/)
    expect(addonProblem(stdio({ tokenEnv: 'TOKEN' }), 'x')).toBe('tokenEnv is only for auth oauth')
    expect(addonProblem(stdio({ auth: 'oauth' }), 'x')).toMatch(/needs tokenEnv/)
    expect(addonProblem(stdio({ auth: 'oauth', tokenEnv: 'T', env: ['T'] }), 'x')).toMatch(/leave it out of env/)
    expect(addonProblem(stdio({ auth: 'fields', env: ['A', 'A'] }), 'x')).toBe('env names A twice')
    expect(addonProblem(http({ auth: 'fields', headers: ['X-Key', 'x-key'] }), 'x')).toBe('headers names x-key twice')
    expect(addonProblem(stdio({ auth: 'fields' }), 'x')).toBe('auth fields needs at least one name in env')
    expect(addonProblem(http({ auth: 'fields' }), 'x')).toBe('auth fields needs at least one name in headers')
    expect(addonProblem(stdio({ env: ['TOKEN'] }), 'x')).toBe('env names values the grant holds; set auth to fields')
  })
})

describe('exposedNames', () => {
  it('joins add-on and tool, cleaning what a tool name cannot hold', () => {
    const names = exposedNames('github', [{ name: 'create_issue' }, { name: 'search.code' }, { name: 'list-prs' }])
    expect([...names]).toEqual([
      ['create_issue', 'github__create_issue'],
      ['search.code', 'github__search_code'],
      ['list-prs', 'github__list-prs']
    ])
  })

  it('cuts a long name to fit and tags it, the same every time', () => {
    const long = 'a_tool_whose_name_runs_far_past_what_claude_allows_for_any_tool'
    const name = exposedNames('my-addon-name-here', [{ name: long }]).get(long)!
    expect(name.length).toBeLessThanOrEqual(EXPOSED_NAME_MAX)
    expect(`mcp__app__${name}`.length).toBeLessThanOrEqual(64)
    expect(name.endsWith(`_${sha256Hex(long).slice(0, 4)}`)).toBe(true)
    expect(name.startsWith('my-addon-name-here__a_tool_whose')).toBe(true)
    expect(exposedNames('my-addon-name-here', [{ name: long }]).get(long)).toBe(name)
  })

  it('tags the names that clean into another, keeping the one cleaning left alone, in any order', () => {
    const tools = [{ name: 'get.file' }, { name: 'get_file' }, { name: 'get/file' }]
    const a = exposedNames('fs', tools)
    const b = exposedNames('fs', [...tools].reverse())
    expect(a.get('get_file')).toBe('fs__get_file')
    expect(a.get('get.file')).toBe(`fs__get_file_${sha256Hex('get.file').slice(0, 4)}`)
    expect(a.get('get/file')).toBe(`fs__get_file_${sha256Hex('get/file').slice(0, 4)}`)
    expect(new Set(a.values()).size).toBe(3)
    for (const [k, v] of a) expect(b.get(k)).toBe(v)
  })
})

describe('the approval cards', () => {
  it('words a stdio add-on with values and both platforms', () => {
    const card = addonCard(stdio({ auth: 'fields', env: ['GITHUB_TOKEN'], args: ['-y', 'server github', "it's"] }), { name: 'github' }, { workspaceName: null, replaces: false })
    expect(card.title).toBe('Add the add-on github')
    expect(Object.keys(card.input)).toEqual(['runs', 'where', 'hosts', 'needs', 'note'])
    expect(card.input).toEqual({
      runs: `npx -y 'server github' 'it'\\''s'`,
      where: 'Every workspace',
      hosts: 'Every host',
      needs: 'Values for GITHUB_TOKEN',
      note: 'It runs as you on every host that starts it.'
    })
  })

  it('words an http add-on, a replacement, one platform and each grant kind', () => {
    const card = addonCard(http({ auth: 'fields', headers: ['X-Api-Key', 'X-Org'], platforms: ['darwin'] }), { name: 'figma' }, { workspaceName: 'temp-code', replaces: true })
    expect(card.title).toBe('Change the add-on figma')
    expect(card.input).toEqual({
      runs: 'https://mcp.example.com/mcp',
      where: 'temp-code',
      hosts: 'Macs only',
      needs: 'Values for X-Api-Key and X-Org',
      note: 'Its tools send requests to this address.'
    })
    expect(addonCard(http({ auth: 'oauth' }), { name: 'linear' }, { workspaceName: null, replaces: false }).input.needs).toBe('A sign-in on the Mac')
    expect(addonCard(stdio({ auth: 'oauth', tokenEnv: 'T', env: ['ORG'] }), { name: 'x' }, { workspaceName: null, replaces: false }).input.needs).toBe(
      'A sign-in on the Mac and values for ORG'
    )
    expect(addonCard(stdio(), { name: 'x' }, { workspaceName: null, replaces: false }).input.needs).toBe('Nothing')
    expect(addonCard(stdio({ platforms: ['linux'] }), { name: 'x' }, { workspaceName: null, replaces: false }).input.hosts).toBe('Linux hosts only')
    expect(addonCard(stdio({ platforms: ['linux', 'darwin'] }), { name: 'x' }, { workspaceName: null, replaces: false }).input.hosts).toBe('Every host')
  })

  it('words a removal, and asks unless a thread wrote it last', () => {
    expect(addonRemoveCard({ name: 'github', addedBy: { kind: 'person', key: 'Phone' } }, { workspaceName: null })).toEqual({
      title: 'Remove the add-on github',
      input: { where: 'Every workspace', addedBy: 'Phone' }
    })
    expect(removeAsks({ writtenBy: { kind: 'thread', sessionId: 's', environmentId: 'e', title: 't' } })).toBe(false)
    expect(removeAsks({ writtenBy: { kind: 'person' } })).toBe(true)
    expect(removeAsks({ writtenBy: { kind: 'import', from: 'x' } })).toBe(true)
  })

  it('only a person with admin may allow an add-on, on either path; other cards and every deny are untouched', () => {
    expect(approvalNeedsAdmin('addon_add')).toBe(true)
    expect(approvalNeedsAdmin('mcp__app__addon_add')).toBe(true)
    expect(approvalNeedsAdmin('Bash')).toBe(false)
    expect(mayAllow('addon_add', { kind: 'local' })).toBe(true)
    expect(mayAllow('addon_add', { kind: 'remote', caps: ['read', 'operate', 'approve', 'admin'] })).toBe(true)
    expect(mayAllow('addon_add', { kind: 'remote', caps: ['read', 'operate', 'approve'] })).toBe(false)
    expect(mayAllow('mcp__app__addon_add', { kind: 'model' })).toBe(false)
    expect(mayAllow('Bash', { kind: 'model' })).toBe(true)
    expect(mayAllow(null, { kind: 'remote', caps: [] })).toBe(true)
    expect(ADDON_ADMIN_LINE).toBe('Needs an admin key')
  })

  it('turns a principal into an approver and guards an allow, never a deny', () => {
    expect(approverOf({ kind: 'local' })).toEqual({ kind: 'local' })
    expect(approverOf({ kind: 'remote', keyId: 'k', name: 'P', audience: 'client', caps: ['read', 'approve'] })).toEqual({ kind: 'remote', caps: ['read', 'approve'] })
    expect(() => assertMayAnswer('addon_add', true, { kind: 'model' })).toThrow('forbidden: approving an add-on needs a person with an admin key')
    expect(() => assertMayAnswer('addon_add', false, { kind: 'model' })).not.toThrow()
    expect(() => assertMayAnswer('Bash', true, { kind: 'model' })).not.toThrow()
  })

  it('quotes an argument only when a shell needs it', () => {
    expect(shellQuote('-y')).toBe('-y')
    expect(shellQuote('@scope/pkg@1.2.3')).toBe('@scope/pkg@1.2.3')
    expect(shellQuote('')).toBe(`''`)
    expect(shellQuote('a b')).toBe(`'a b'`)
  })
})
