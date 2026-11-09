import { describe, expect, it } from 'vitest'
import { scopedCodexPath } from '../src/main/server/gateway'
import {
  CLAUDE_AUTH_PLACEHOLDER,
  CLAUDE_CREDENTIAL_VARS,
  CLAUDE_OAUTH_PLACEHOLDER,
  CODEX_ACCESS_PLACEHOLDER,
  MUSE_KEY_PLACEHOLDER,
  PLACEHOLDER_EXPIRY_MS,
  PLACEHOLDERS,
  claudeCredentialVariants,
  codexFrontPath,
  findSecrets,
  jwtClaims,
  makeNonces,
  nonceHits,
  placeholderClaudeCredentials,
  placeholderCodexAuth,
  placeholderMuseAuth,
  probePluginTree,
  redactEvidence,
  treeDiff,
  type TreeEntry
} from './lib/configDirSpike'

// Token-shaped strings built at run time, so this file holds none a scanner would flag.
const fake = (prefix: string, n = 40): string => `${prefix}${'x7Q'.repeat(Math.ceil(n / 3)).slice(0, n)}`
const SECRETS = {
  anthropic: fake('sk-ant-api03-'),
  oauth: fake('sk-ant-oat01-'),
  openai: fake('sk-proj-'),
  meta: fake('LLM_1607_'),
  jwt: `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from('{"sub":"someone-real"}').toString('base64url')}.${fake('', 30)}`,
  tcKey: `tc_${fake('', 10)}.${fake('', 24)}`,
  github: fake('ghp_', 36)
}

describe('redactEvidence', () => {
  it('redacts every token shape at any depth, with its length', () => {
    const out = redactEvidence({
      a: SECRETS.anthropic,
      list: [{ deep: { deeper: `the CLI said ${SECRETS.oauth} then stopped` } }],
      jwt: SECRETS.jwt,
      meta: [SECRETS.meta],
      openai: SECRETS.openai,
      tc: SECRETS.tcKey,
      gh: `token ${SECRETS.github}`,
      header: `Bearer ${fake('', 30)}`
    })
    expect(out.a).toBe(`<redacted:${SECRETS.anthropic.length}>`)
    expect(out.list[0].deep.deeper).toBe(`the CLI said <redacted:${SECRETS.oauth.length}> then stopped`)
    expect(out.jwt).toBe(`<redacted:${SECRETS.jwt.length}>`)
    expect(out.meta[0]).toBe(`<redacted:${SECRETS.meta.length}>`)
    expect(out.openai).toBe(`<redacted:${SECRETS.openai.length}>`)
    expect(out.tc).toBe(`<redacted:${SECRETS.tcKey.length}>`)
    expect(out.gh).toBe(`token <redacted:${SECRETS.github.length}>`)
    expect(out.header).toBe('Bearer <redacted:30>')
  })

  it('redacts any string under a secret-named key, case-insensitively, at any depth', () => {
    const out = redactEvidence({
      env: { MY_SECRET: 'hunter2', Cookie: 'session=abc', PASSWORD: 'pw' },
      nested: [{ Authorization: 'Basic abc' }, { apiKey: 'short' }],
      auth: { tokens: { inner: 'whatever' } },
      refreshToken: ''
    })
    expect(out.env).toEqual({ MY_SECRET: '<redacted:7>', Cookie: '<redacted:11>', PASSWORD: '<redacted:2>' })
    expect(out.nested).toEqual([{ Authorization: '<redacted:9>' }, { apiKey: '<redacted:5>' }])
    expect(out.auth.tokens.inner).toBe('<redacted:8>')
    expect(out.refreshToken).toBe('')
  })

  it('keeps placeholders, paths, facts about secrets, numbers and booleans', () => {
    const value = {
      env: { ANTHROPIC_AUTH_TOKEN: CLAUDE_AUTH_PLACEHOLDER, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH_PLACEHOLDER, CLAUDE_CONFIG_DIR: '/tmp/tc-config-spike/r1/C2b/config' },
      header: `Bearer ${CLAUDE_OAUTH_PLACEHOLDER}`,
      access: CODEX_ACCESS_PLACEHOLDER,
      key: MUSE_KEY_PLACEHOLDER,
      apiKeySource: 'ANTHROPIC_AUTH_TOKEN',
      authScheme: 'bearer',
      tokenKind: 'other',
      tokenLength: 108,
      authPath: '/srv/agents/home/.claude/.credentials.json',
      tokenPresent: true,
      path: '/tmp/a.b.c/eyJ.not.a.jwt'
    }
    expect(redactEvidence(value)).toEqual(value)
  })

  it('never keeps a token because the string also names a placeholder', () => {
    const line = `token ${CLAUDE_AUTH_PLACEHOLDER} then ${SECRETS.anthropic}`
    expect(redactEvidence({ line }).line).toBe(`token ${CLAUDE_AUTH_PLACEHOLDER} then <redacted:${SECRETS.anthropic.length}>`)
  })
})

describe('findSecrets', () => {
  const raw = {
    env: { ANTHROPIC_API_KEY: SECRETS.anthropic, ANTHROPIC_AUTH_TOKEN: CLAUDE_AUTH_PLACEHOLDER, MY_PASSWORD: 'hunter2' },
    log: `GET /v1/models Authorization: Bearer ${fake('', 20)} done`,
    jwt: SECRETS.jwt,
    meta: SECRETS.meta,
    gh: SECRETS.github,
    tc: SECRETS.tcKey,
    apiKeySource: 'ANTHROPIC_API_KEY',
    oauth: CLAUDE_OAUTH_PLACEHOLDER
  }

  it('finds what redactEvidence removes, by kind and place, never the value', () => {
    const text = JSON.stringify(raw, null, 2)
    const found = findSecrets(text)
    const kinds = found.map((f) => f.kind).sort()
    expect(kinds).toEqual(['anthropic-key', 'bearer', 'github-token', 'jwt', 'meta-key', 'secret-key', 'secret-key', 'temp-code-key'].sort())
    expect(found.find((f) => f.kind === 'secret-key' && f.key === 'MY_PASSWORD')).toBeTruthy()
    for (const f of found) expect(Object.keys(f).sort()).toEqual(f.key ? ['at', 'key', 'kind', 'length'] : ['at', 'kind', 'length'])
    expect(JSON.stringify(found)).not.toContain('hunter2')
  })

  it('finds nothing in redacted output', () => {
    expect(findSecrets(JSON.stringify(redactEvidence(raw), null, 2))).toEqual([])
  })

  it('finds a secret nested under a secret-named key, as redactEvidence removes it', () => {
    for (const raw of [{ auth: { value: 'opaque-secret' } }, { passwords: ['opaque-secret'] }, { a: [{ b: { cookie: { c: 'opaque-secret' } } }] }]) {
      expect(findSecrets(JSON.stringify(raw)).map((f) => f.kind)).toEqual(['secret-key'])
      expect(findSecrets(JSON.stringify(redactEvidence(raw)))).toEqual([])
    }
  })

  it('reads no pairs out of stringified JSON inside a string', () => {
    expect(findSecrets(JSON.stringify({ note: JSON.stringify({ token: 'abc' }) }))).toEqual([])
  })
})

describe('nonceHits', () => {
  it('names the needles a body holds and nothing of the body', () => {
    const nonces = makeNonces('r1')
    const body = JSON.stringify({ system: `skills: tc-probe-skill (${nonces.skillDesc})`, messages: [{ content: `${nonces.skillBody} — the person's private prompt` }] })
    const hits = nonceHits(body, { ...nonces, skillName: 'tc-probe-skill', toolName: 'tc_probe_echo' })
    expect(hits).toEqual(['skillBody', 'skillDesc', 'skillName'])
    expect(JSON.stringify(hits)).not.toContain('private')
  })

  it('ignores an empty needle', () => {
    expect(nonceHits('anything', { empty: '' })).toEqual([])
  })
})

describe('treeDiff', () => {
  const e = (path: string, kind: TreeEntry['kind'], size = 1, mtimeMs = 1, target?: string): TreeEntry => ({ path, kind, size, mtimeMs, ...(target ? { target } : {}) })

  it('lists entries added, removed and changed', () => {
    const before = [e('a', 'file'), e('b', 'file'), e('c', 'link', 0, 1, '/x'), e('d', 'dir', 64, 1), e('f', 'file', 1, 1)]
    const after = [e('a', 'file'), e('c', 'link', 0, 1, '/y'), e('d', 'dir', 96, 9), e('f', 'file', 2, 1), e('g', 'file')]
    const d = treeDiff(before, after)
    expect(d.added.map((x) => x.path)).toEqual(['g'])
    expect(d.removed.map((x) => x.path)).toEqual(['b'])
    // A dir's own size and mtime are its entries' change, not its own.
    expect(d.changed.map((x) => x.path)).toEqual(['c', 'f'])
  })

  it('reports a kind change', () => {
    expect(treeDiff([e('x', 'file')], [e('x', 'link', 0, 1, '/t')]).changed.map((c) => [c.before.kind, c.after.kind])).toEqual([['file', 'link']])
  })
})

describe('probePluginTree', () => {
  const nonces = makeNonces('r2')
  const opts = { hookMarker: '/tmp/run/hook marker', mcp: { command: 'bun', args: ['/tmp/run/mcp.ts'] } }

  it('writes the skills, command, agent, hook, MCP server and manifest, each with its nonce', () => {
    const tree = probePluginTree(nonces, opts)
    expect(Object.keys(tree).sort()).toEqual([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'agents/tc-probe-agent.md',
      'commands/tc-probe-cmd.md',
      'hooks/hooks.json',
      'skills/tc-gone-skill/SKILL.md',
      'skills/tc-probe-skill/SKILL.md'
    ])
    expect(tree['skills/tc-probe-skill/SKILL.md']).toContain('name: tc-probe-skill')
    expect(tree['skills/tc-probe-skill/SKILL.md']).toContain(nonces.skillDesc)
    expect(tree['skills/tc-probe-skill/SKILL.md']).toContain(nonces.skillBody)
    expect(tree['skills/tc-gone-skill/SKILL.md']).toContain(nonces.goneBody)
    expect(tree['commands/tc-probe-cmd.md']).toContain(nonces.cmd)
    expect(tree['agents/tc-probe-agent.md']).toContain(nonces.agent)
    expect(JSON.parse(tree['.claude-plugin/plugin.json']).name).toBe('tc-store')
    expect(JSON.parse(tree['.mcp.json']).mcpServers['tc-probe']).toEqual(opts.mcp)
    const hook = JSON.parse(tree['hooks/hooks.json']).hooks.UserPromptSubmit[0].hooks[0]
    expect(hook).toEqual({ type: 'command', command: "touch '/tmp/run/hook marker'" })
  })

  it('leaves the manifest out for a bare dir and the MCP server out when asked', () => {
    const tree = probePluginTree(nonces, { ...opts, manifest: false, mcp: null })
    expect(tree['.claude-plugin/plugin.json']).toBeUndefined()
    expect(tree['.mcp.json']).toBeUndefined()
    expect(tree['skills/tc-probe-skill/SKILL.md']).toBeDefined()
  })
})

describe('claudeCredentialVariants', () => {
  it('has C2a to C2d, each clearing every credential variable first', () => {
    const v = claudeCredentialVariants({ configDir: '/tmp/c', baseUrl: 'http://127.0.0.1:1' })
    expect(Object.keys(v)).toEqual(['C2a', 'C2b', 'C2c', 'C2d'])
    for (const x of Object.values(v)) {
      expect(x.env.CLAUDE_CONFIG_DIR).toBe('/tmp/c')
      expect(x.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1')
      expect([...x.unset].sort()).toEqual([...CLAUDE_CREDENTIAL_VARS].sort())
    }
    expect(v.C2a.realHome).toBe(true)
    expect(Object.keys(v.C2a.env).sort()).toEqual(['ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'])
    expect(v.C2b.env.ANTHROPIC_AUTH_TOKEN).toBe(CLAUDE_AUTH_PLACEHOLDER)
    expect(v.C2c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_OAUTH_PLACEHOLDER)
    expect(Object.keys(v.C2d.files)).toEqual(['.credentials.json'])
    expect([v.C2b, v.C2c, v.C2d].every((x) => !x.realHome)).toBe(true)
  })
})

describe('placeholders', () => {
  it('Claude: parses, no refresh token, expires after 2099', () => {
    const c = JSON.parse(placeholderClaudeCredentials()).claudeAiOauth
    expect(c.accessToken).toBe(CLAUDE_OAUTH_PLACEHOLDER)
    expect(c.refreshToken).toBeUndefined()
    expect(c.expiresAt).toBeGreaterThan(Date.UTC(2099, 11, 31))
  })

  it('Codex: parses, JWT claims expire after 2099, no refresh token', () => {
    const auth = JSON.parse(placeholderCodexAuth())
    expect(auth.auth_mode).toBe('chatgpt')
    expect(auth.tokens.refresh_token).toBeFalsy()
    for (const jwt of [auth.tokens.id_token, auth.tokens.access_token]) {
      const claims = jwtClaims(jwt)!
      expect((claims.exp as number) * 1000).toBeGreaterThan(Date.UTC(2099, 11, 31))
      expect((claims['https://api.openai.com/auth'] as { chatgpt_account_id: string }).chatgpt_account_id).toBe(auth.tokens.account_id)
    }
    expect(new Date(auth.last_refresh).getTime()).toBeLessThan(PLACEHOLDER_EXPIRY_MS)
  })

  it('Muse: parses, a static login with no refresh token and no expiry', () => {
    const meta = JSON.parse(placeholderMuseAuth()).providers.meta
    expect(meta.api_key).toBe(MUSE_KEY_PLACEHOLDER)
    expect(Object.keys(meta).some((k) => /refresh|expir/i.test(k))).toBe(false)
  })

  it('no token shape in a placeholder file is flagged, and every placeholder value survives redaction', () => {
    // A login file's other strings sit under login keys (claudeAiOauth, tokens, providers.meta) and count as secret-key, as redaction treats them.
    for (const text of [placeholderClaudeCredentials(), placeholderCodexAuth(), placeholderMuseAuth()]) expect(findSecrets(text).filter((f) => f.kind !== 'secret-key')).toEqual([])
    const values = [...PLACEHOLDERS]
    expect(redactEvidence({ token: values, log: values.join(' ') })).toEqual({ token: values, log: values.join(' ') })
  })
})

describe('codexFrontPath', () => {
  const scope = { thread: 'probe 1', account: 'me@x.com', pin: true, model: 'gpt-6.1-sol' }
  it.each(['/backend-api/codex/responses', '/backend-api/wham/accounts/check', '/codex/api/codex/settings/user', '/codex/~t=T;a=A/codex/responses', '/__aliax/usage'])(
    'equals the gateway scopedCodexPath for %s',
    (url) => {
      expect(codexFrontPath(url, scope)).toBe(scopedCodexPath(url, scope))
    }
  )
  it('writes the scope with its model', () => {
    expect(codexFrontPath('/backend-api/codex/responses', scope)).toBe('/codex/~t=probe%201;a=me%40x.com;pin=1;m=gpt-6.1-sol/codex/responses')
  })
})
