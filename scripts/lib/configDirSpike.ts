/**
 * The pure half of the config-dir spike (scripts/spike-config-dirs.ts): the
 * redaction every evidence file goes through, the secret scan run before a
 * commit, the request-body nonce check, tree diffs, the probe plugin's files,
 * the Claude credential variants and the placeholder login files. Nothing
 * here touches the disk, the network or a process.
 *
 * A placeholder is a credential the probe made up: it opens nothing, carries
 * no refresh grant and expires in 2100. Redaction keeps placeholders verbatim
 * so the evidence can say which credential a CLI presented.
 */

/** The mark every placeholder value carries in plain text. */
export const PLACEHOLDER_MARK = 'tc-placeholder'

/** 2100-01-01T00:00:00Z: every placeholder's expiry. */
export const PLACEHOLDER_EXPIRY_MS = Date.UTC(2100, 0, 1)

/** `ANTHROPIC_AUTH_TOKEN` for a fake run (the gateway swaps it in a real one). */
export const CLAUDE_AUTH_PLACEHOLDER = 'tc-placeholder'
/** `CLAUDE_CODE_OAUTH_TOKEN` and the placeholder `.credentials.json`'s access token: an OAuth token's prefix, so the CLI takes it for one. */
export const CLAUDE_OAUTH_PLACEHOLDER = 'sk-ant-oat01-tc-placeholder-000000000000000000000000000000000000000000000000'
export const CODEX_ACCOUNT_PLACEHOLDER = 'tc-placeholder-account'
export const MUSE_ACCESS_PLACEHOLDER = 'tc-placeholder-muse-access'
export const MUSE_KEY_PLACEHOLDER = 'LLM_0000_tc-placeholder-muse-key'
export const PLACEHOLDER_EMAIL = 'tc-placeholder@example.invalid'

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * A JWT with these claims that nobody signed: the shape codex parses. The
 * signature part is a fixed word, not empty: codex 0.163 reads a token with
 * an empty third part as no login at all.
 */
export function placeholderJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.${Buffer.from('tc-placeholder-signature').toString('base64url')}`
}

/** The claims of a JWT's payload, null when it is not one. */
export function jwtClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const CODEX_CLAIMS = {
  iss: 'https://auth.openai.com',
  aud: ['app_tc_placeholder'],
  sub: 'tc-placeholder-user',
  email: PLACEHOLDER_EMAIL,
  email_verified: true,
  iat: Date.UTC(2026, 0, 1) / 1000,
  exp: PLACEHOLDER_EXPIRY_MS / 1000,
  'https://api.openai.com/auth': {
    chatgpt_account_id: CODEX_ACCOUNT_PLACEHOLDER,
    chatgpt_plan_type: 'pro',
    chatgpt_user_id: 'tc-placeholder-user',
    user_id: 'tc-placeholder-user'
  }
}
export const CODEX_ID_PLACEHOLDER = placeholderJwt({ ...CODEX_CLAIMS, at_hash: 'tc-placeholder' })
export const CODEX_ACCESS_PLACEHOLDER = placeholderJwt({ ...CODEX_CLAIMS, scp: ['openid', 'profile', 'email'] })

/** Every value the probe made up, kept verbatim by redaction and the scan. */
export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  CLAUDE_AUTH_PLACEHOLDER,
  CLAUDE_OAUTH_PLACEHOLDER,
  CODEX_ACCOUNT_PLACEHOLDER,
  CODEX_ID_PLACEHOLDER,
  CODEX_ACCESS_PLACEHOLDER,
  MUSE_ACCESS_PLACEHOLDER,
  MUSE_KEY_PLACEHOLDER,
  PLACEHOLDER_EMAIL
])

/** Exactly one of PLACEHOLDERS: a longer string that only mentions one is still scanned. */
const isPlaceholder = (s: string): boolean => PLACEHOLDERS.has(s)

/** A Claude `.credentials.json` with an access token and no refresh grant. */
export function placeholderClaudeCredentials(): string {
  return `${JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: CLAUDE_OAUTH_PLACEHOLDER,
        expiresAt: PLACEHOLDER_EXPIRY_MS,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max'
      }
    },
    null,
    2
  )}\n`
}

/** A codex `auth.json` in ChatGPT mode: JWTs codex parses, an empty refresh token. */
export function placeholderCodexAuth(): string {
  return `${JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { id_token: CODEX_ID_PLACEHOLDER, access_token: CODEX_ACCESS_PLACEHOLDER, refresh_token: '', account_id: CODEX_ACCOUNT_PLACEHOLDER },
      last_refresh: new Date(PLACEHOLDER_EXPIRY_MS - 86_400_000).toISOString()
    },
    null,
    2
  )}\n`
}

/** A Muse `auth.json`: the device-code login's fields; static, so no expiry and no refresh grant. */
export function placeholderMuseAuth(): string {
  return `${JSON.stringify(
    {
      schema_version: 1,
      providers: {
        meta: {
          access_token: MUSE_ACCESS_PLACEHOLDER,
          api_key: MUSE_KEY_PLACEHOLDER,
          mechanism: 'oauth',
          obtained_via: 'device_code',
          api_base_url: 'https://api.meta.ai/v1',
          subs_active: true,
          user_full_name: 'TC Placeholder',
          user_email: PLACEHOLDER_EMAIL
        }
      }
    },
    null,
    2
  )}\n`
}

// ── redaction ────────────────────────────────────────────────────────────────

/** Token shapes, wherever they sit in a string. */
const TOKEN_SHAPES: { kind: string; re: RegExp }[] = [
  { kind: 'bearer', re: /\bBearer\s+([^\s"',;]+)/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { kind: 'openai-key', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { kind: 'meta-key', re: /\bLLM_[A-Za-z0-9_|.-]{8,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g },
  { kind: 'temp-code-key', re: /\btc_[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g }
]

/** A key whose value is a secret: matched case-insensitively at any depth. */
const SECRET_KEY = /token|key|secret|auth|password|cookie|authorization/i
/** Keys that match SECRET_KEY by their words but name a fact about a secret, never the secret. */
const SAFE_KEY = /(source|scheme|kind|length|count|names|present|backend|mode|shape|path|file|dir|headers|hits|ids|seen)$/i

export const isSecretKey = (key: string): boolean => SECRET_KEY.test(key) && !SAFE_KEY.test(key)

const redacted = (s: string): string => `<redacted:${s.length}>`
const REDACTED = /^<redacted:\d+>$/

/** One string with every token shape replaced; placeholders stay. */
function redactString(s: string): string {
  let out = s
  for (const { kind, re } of TOKEN_SHAPES) {
    out = out.replace(re, (match, group?: string) => {
      if (kind === 'bearer') return isPlaceholder(group ?? '') || REDACTED.test(group ?? '') ? match : `Bearer ${redacted(group ?? '')}`
      return isPlaceholder(match) ? match : redacted(match)
    })
  }
  return out
}

/**
 * A copy of `value` safe to commit: every string under a secret-named key
 * (any depth) and every token-shaped string anywhere becomes `<redacted:N>`,
 * N its length. Placeholders, empty strings, numbers and booleans stay.
 */
export function redactEvidence<T>(value: T): T {
  const walk = (v: unknown, secret: boolean): unknown => {
    if (typeof v === 'string') {
      if (!v || isPlaceholder(v) || REDACTED.test(v)) return v
      return secret ? redacted(v) : redactString(v)
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, secret))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, secret || isSecretKey(k))
      return out
    }
    return v
  }
  return walk(value, false) as T
}

export interface SecretFinding {
  kind: string
  /** Offset of the finding in the text. */
  at: number
  length: number
  /** The key it sat under, for a secret-named key's value. */
  key?: string
}

/**
 * Every secret in a text (an evidence file, a fixture): token shapes, and
 * string values under secret-named JSON keys. Reports where, never what.
 */
export function findSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = []
  for (const { kind, re } of TOKEN_SHAPES) {
    for (const m of text.matchAll(re)) {
      const value = kind === 'bearer' ? (m[1] ?? '') : m[0]
      if (isPlaceholder(value) || REDACTED.test(value) || value.startsWith('<redacted:')) continue
      found.push({ kind, at: m.index ?? 0, length: m[0].length })
    }
  }
  // JSON: every string under a secret-named key, at any depth, as redactEvidence sees it.
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    // not JSON: the token shapes alone
  }
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === 'string') {
      if (key === null || !v || isPlaceholder(v) || REDACTED.test(v)) return
      const at = text.indexOf(JSON.stringify(v))
      found.push({ kind: 'secret-key', at, length: JSON.stringify(v).length, key })
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ?? (isSecretKey(k) ? k : null))
  }
  if (doc !== undefined) walk(doc, null)
  return found.sort((a, b) => a.at - b.at)
}

/** The names of the needles a body holds; nothing of the body. */
export function nonceHits(body: string, needles: Record<string, string>): string[] {
  return Object.entries(needles)
    .filter(([, needle]) => needle && body.includes(needle))
    .map(([name]) => name)
    .sort()
}

// ── trees ────────────────────────────────────────────────────────────────────

export interface TreeEntry {
  /** Relative to the listed root. */
  path: string
  kind: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtimeMs: number
  /** A link's target. */
  target?: string
}

export interface TreeChange {
  path: string
  before: TreeEntry
  after: TreeEntry
}

export interface TreeDiff {
  added: TreeEntry[]
  removed: TreeEntry[]
  changed: TreeChange[]
}

/** Entries added, removed and changed (kind, size, mtime or link target) between two listings. */
export function treeDiff(before: TreeEntry[], after: TreeEntry[]): TreeDiff {
  const old = new Map(before.map((e) => [e.path, e]))
  const now = new Map(after.map((e) => [e.path, e]))
  const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const added = after.filter((e) => !old.has(e.path)).sort(byPath)
  const removed = before.filter((e) => !now.has(e.path)).sort(byPath)
  const changed: TreeChange[] = []
  for (const e of after) {
    const o = old.get(e.path)
    if (!o) continue
    // A directory's size and mtime move with every entry under it: its own change is its entries'.
    const differs = o.kind !== e.kind || o.target !== e.target || (e.kind !== 'dir' && (o.size !== e.size || o.mtimeMs !== e.mtimeMs))
    if (differs) changed.push({ path: e.path, before: o, after: e })
  }
  return { added, removed, changed: changed.sort(byPath) }
}

/** No entry added, removed or changed. */
export const treeSame = (d: TreeDiff): boolean => !d.added.length && !d.removed.length && !d.changed.length

// ── the probe plugin ─────────────────────────────────────────────────────────

/** The nonces one run plants: each a unique word the fakes look for in request bodies. */
export interface ProbeNonces {
  skillDesc: string
  skillBody: string
  goneDesc: string
  goneBody: string
  cmd: string
  agent: string
  lateDesc: string
  lateBody: string
  editedDesc: string
  editedBody: string
}

export function makeNonces(seed: string): ProbeNonces {
  const n = (name: string): string => `tcnonce-${seed}-${name}`
  return {
    skillDesc: n('skilldesc'),
    skillBody: n('skillbody'),
    goneDesc: n('gonedesc'),
    goneBody: n('gonebody'),
    cmd: n('cmd'),
    agent: n('agent'),
    lateDesc: n('latedesc'),
    lateBody: n('latebody'),
    editedDesc: n('editeddesc'),
    editedBody: n('editedbody')
  }
}

/** A SKILL.md naming itself, its description and body each carrying a nonce. */
export function skillFile(name: string, descNonce: string, bodyNonce: string): string {
  return `---\nname: ${name}\ndescription: Probe skill ${name} (${descNonce}). Use only when asked to run ${name}.\n---\n\nThe probe skill ${name} loaded. Say the word ${bodyNonce} and nothing else.\n`
}

export interface ProbePluginOptions {
  /** Write `.claude-plugin/plugin.json` (false: a bare dir, C1d). Default true. */
  manifest?: boolean
  /** The manifest's name. Default `tc-store`. */
  name?: string
  /** The file the UserPromptSubmit hook touches. */
  hookMarker: string
  /** The probe MCP server's command, or null for no `.mcp.json`. */
  mcp: { command: string; args: string[] } | null
}

/** The probe plugin's files, path → content, relative to the plugin root. */
export function probePluginTree(nonces: ProbeNonces, opts: ProbePluginOptions): Record<string, string> {
  const files: Record<string, string> = {
    'skills/tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', nonces.skillDesc, nonces.skillBody),
    'skills/tc-gone-skill/SKILL.md': skillFile('tc-gone-skill', nonces.goneDesc, nonces.goneBody),
    'commands/tc-probe-cmd.md': `---\ndescription: Probe command (${nonces.cmd})\n---\n\nThe probe command ran. Say the word ${nonces.cmd} and nothing else.\n`,
    'agents/tc-probe-agent.md': `---\nname: tc-probe-agent\ndescription: Probe agent (${nonces.agent}). Use only when asked for the probe agent.\n---\n\nYou are the probe agent. Say the word ${nonces.agent}.\n`,
    'hooks/hooks.json': `${JSON.stringify(
      { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${shellQuote(opts.hookMarker)}` }] }] } },
      null,
      2
    )}\n`
  }
  if (opts.manifest ?? true) {
    files['.claude-plugin/plugin.json'] = `${JSON.stringify({ name: opts.name ?? 'tc-store', version: '0.0.1', description: 'The config-dir spike probe plugin' }, null, 2)}\n`
  }
  if (opts.mcp) files['.mcp.json'] = `${JSON.stringify({ mcpServers: { 'tc-probe': { command: opts.mcp.command, args: opts.mcp.args } } }, null, 2)}\n`
  return files
}

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// ── Claude credential variants (C2a–d) ───────────────────────────────────────

/** Every variable through which a Claude CLI can be handed a credential. */
export const CLAUDE_CREDENTIAL_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'] as const

export interface CredentialVariant {
  /** What the variant tests, in a line. */
  summary: string
  /** Set on the CLI's environment. */
  env: Record<string, string>
  /** Removed from the inherited environment first. */
  unset: string[]
  /** Written into the config root, path → content. */
  files: Record<string, string>
  /** Runs with the person's real HOME (C2a: the Keychain lookup is the subject). */
  realHome: boolean
}

/** The C2a–d table: an owned config root with each way a credential can reach the CLI. */
export function claudeCredentialVariants(base: { configDir: string; baseUrl: string }): Record<'C2a' | 'C2b' | 'C2c' | 'C2d', CredentialVariant> {
  const env = { CLAUDE_CONFIG_DIR: base.configDir, ANTHROPIC_BASE_URL: base.baseUrl }
  const unset = [...CLAUDE_CREDENTIAL_VARS]
  return {
    C2a: { summary: 'no credential: what the CLI resolves on its own under an owned root', env, unset, files: {}, realHome: true },
    C2b: { summary: 'ANTHROPIC_AUTH_TOKEN (token mode, as metaClaudeEnv and the e2e proofs)', env: { ...env, ANTHROPIC_AUTH_TOKEN: CLAUDE_AUTH_PLACEHOLDER }, unset, files: {}, realHome: false },
    C2c: { summary: 'CLAUDE_CODE_OAUTH_TOKEN (what `claude setup-token` prints)', env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH_PLACEHOLDER }, unset, files: {}, realHome: false },
    C2d: { summary: 'a .credentials.json in the owned root', env, unset, files: { '.credentials.json': placeholderClaudeCredentials() }, realHome: false }
  }
}

// ── the codex front ──────────────────────────────────────────────────────────

export interface FrontScope {
  thread: string
  account: string
  pin?: boolean
  model?: string
}

/** One scope's path segment, encoded as aliax-core's scopeSegment writes it. */
export function scopeSegmentOf(scope: FrontScope): string {
  const parts = [`t=${encodeURIComponent(scope.thread)}`, `a=${encodeURIComponent(scope.account)}`]
  if (scope.pin) parts.push('pin=1')
  if (scope.model) parts.push(`m=${encodeURIComponent(scope.model)}`)
  return `~${parts.join(';')}`
}

/**
 * Where the https front forwards a codex request in a real run: the gateway's
 * plain port under `/codex/<scope>`, the path its own per-thread port writes
 * (gatewayCore.ts scopedCodexPath): `/backend-api` or `/codex` stripped.
 */
export function codexFrontPath(url: string, scope: FrontScope): string {
  if (url === '/__aliax' || url.startsWith('/__aliax/') || url.startsWith('/__aliax?')) return url
  let rest = url
  if (rest === '/backend-api' || rest.startsWith('/backend-api/')) rest = rest.slice('/backend-api'.length)
  else if (rest === '/codex' || rest.startsWith('/codex/')) rest = rest.slice('/codex'.length)
  if (rest.startsWith('/~')) return `/codex${rest}`
  return `/codex/${scopeSegmentOf(scope)}${rest}`
}
