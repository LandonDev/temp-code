import { z } from 'zod'
import { sha256Hex } from './sha256'
import type { AddonSpec } from './contract-addons'

/**
 * The add-on registry's pure rules (CLAUDE.md "Add-ons and skills: one
 * store, on the box"): names, who wrote a row, which rows a thread sees,
 * the secret check every spec passes, the names threads call an add-on's
 * tools by, the approval card's words and the words of the tools threads
 * get. The wire shapes are contract-addons.ts; the store is
 * src/main/server/addonStore.ts.
 */

/** ≤ 20, so `<addon>__<tool>` fits Claude's 64-character tool names under `mcp__app__`. */
export const ADDON_NAME_RE = /^[a-z][a-z0-9-]{0,19}$/

export const WriterSchema = z.discriminatedUnion('kind', [
  /** A person: the local socket, or a remote key (`key` is the key's name). */
  z.object({ kind: z.literal('person'), key: z.string().max(120).optional() }),
  /** A thread, by its root session on the host it ran on. */
  z.object({ kind: z.literal('thread'), sessionId: z.string(), environmentId: z.string(), title: z.string().max(200) }),
  /** Imported from a harness's own config, e.g. a skill folder by the skills store core's one-time import (`from`: `~/.claude/skills/x`). */
  z.object({ kind: z.literal('import'), from: z.string().max(2_000) })
])
export type Writer = z.infer<typeof WriterSchema>

/** A writer in the cards' words: `You`, the key's name, the thread's title, or `Imported`. */
export function writerWords(writer: Writer): string {
  if (writer.kind === 'person') return writer.key ?? 'You'
  if (writer.kind === 'thread') return writer.title || 'A thread'
  return 'Imported'
}

/** A scope in the cards' words. */
export const scopeWords = (workspaceName: string | null): string => workspaceName ?? 'Every workspace'

/**
 * What a thread in `workspaceId` sees: every global row plus its
 * workspace's, a workspace row shadowing the global row of the same name.
 * A thread with no workspace sees the global rows. Sorted by name.
 */
export function visibleRows<T extends { name: string; workspaceId: string | null }>(rows: readonly T[], workspaceId: string | null): T[] {
  const byName = new Map<string, T>()
  for (const row of rows) if (row.workspaceId === null) byName.set(row.name, row)
  if (workspaceId !== null) for (const row of rows) if (row.workspaceId === workspaceId) byName.set(row.name, row)
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// ── secrets ─────────────────────────────────────────────────────────────

const TOKEN_SHAPES: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/,
  /gh[opusr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /glpat-[A-Za-z0-9_-]{16,}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /ya29\.[0-9A-Za-z_-]{20,}/,
  /LLM_\d+_/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN/
]
/** A URL whose userinfo carries a password. */
const URL_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^/?#@\s:]*:[^/?#@\s]+@/i
/** A query parameter with a value whose name is, or ends in, a secret's word. */
const QUERY_PARAM = /[?&]([^=&#\s]+)=([^&#\s]+)/g
const SECRET_PARAM = /(?:^|[_-]|api|access|client)(?:token|key|secret|password|passwd|auth)$/i
const ALNUM_RUN = /[A-Za-z0-9]{32,}/g

/**
 * A heuristic for a secret typed into a command line or a URL: a known
 * token shape, a password in a URL, a query parameter named for a secret,
 * or a run of 32+ letters and digits in mixed case in a word with no `/`,
 * `.` or `@` (package names and paths pass). The card shows the whole
 * command line to an admin before anything runs; this is the early catch.
 */
export function looksSecret(s: string): boolean {
  if (TOKEN_SHAPES.some((re) => re.test(s))) return true
  if (URL_PASSWORD.test(s)) return true
  for (const m of s.matchAll(QUERY_PARAM)) if (SECRET_PARAM.test(m[1]!)) return true
  for (const word of s.split(/\s+/)) {
    if (/[/.@]/.test(word)) continue
    for (const m of word.matchAll(ALNUM_RUN)) {
      const run = m[0]
      if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) return true
    }
  }
  return false
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const isLoopback = (host: string): boolean => LOOPBACK.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host)

const duplicate = (names: readonly string[], fold = false): string | null => {
  const seen = new Set<string>()
  for (const n of names) {
    const k = fold ? n.toLowerCase() : n
    if (seen.has(k)) return n
    seen.add(k)
  }
  return null
}

/**
 * Why an add-on cannot be saved as written, or null. `addons.set` and
 * `addon_add` answer `refused: <problem>`.
 */
export function addonProblem(spec: AddonSpec, name: string): string | null {
  if (!ADDON_NAME_RE.test(name)) return 'name takes lowercase letters, digits and dashes, starts with a letter and is at most 20 characters'
  const fields = spec.transport === 'stdio' ? spec.env : spec.headers
  if (spec.transport === 'stdio') {
    const hint = 'name the variable in env and its value goes in the add-on\'s grant'
    if (looksSecret(spec.command)) return `command looks like a secret; ${hint}`
    const at = spec.args.findIndex(looksSecret)
    if (at >= 0) return `args[${at}] looks like a secret; ${hint}`
    const dup = duplicate(spec.env)
    if (dup) return `env names ${dup} twice`
    if (spec.tokenEnv !== undefined) {
      if (spec.auth !== 'oauth') return 'tokenEnv is only for auth oauth'
      if (spec.env.includes(spec.tokenEnv)) return `${spec.tokenEnv} is the token's variable; leave it out of env`
    } else if (spec.auth === 'oauth') return 'auth oauth on a stdio add-on needs tokenEnv: the variable that gets the access token'
  } else {
    if (looksSecret(spec.url)) return 'url looks like a secret; name the header in headers and its value goes in the add-on\'s grant'
    let url: URL
    try {
      url = new URL(spec.url)
    } catch {
      return 'url is not a URL'
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) return 'url must be https, or plain http to this machine'
    const dup = duplicate(spec.headers, true)
    if (dup) return `headers names ${dup} twice`
  }
  if (spec.auth === 'fields' && fields.length === 0) return `auth fields needs at least one name in ${spec.transport === 'stdio' ? 'env' : 'headers'}`
  if (spec.auth === 'none' && fields.length > 0) return `${spec.transport === 'stdio' ? 'env' : 'headers'} names values the grant holds; set auth to fields`
  return null
}

// ── the names threads call an add-on's tools by ─────────────────────────

/** `mcp__app__` plus an exposed name fits Claude's 64 characters. */
export const EXPOSED_NAME_MAX = 54
const cleanName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * Each downstream tool's name as threads call it: `<addon>__<tool>`, every
 * character outside `[A-Za-z0-9_-]` turned to `_`. A name over
 * EXPOSED_NAME_MAX has its tool part cut to fit and ends `_` plus the first
 * four hex of the original name's sha256; so does a name that cleaned into
 * another's (a name cleaning left alone keeps its own). Stable for the same
 * input, whatever the order.
 */
export function exposedNames(addon: string, tools: readonly { name: string }[]): Map<string, string> {
  const prefix = `${cleanName(addon)}__`
  const tagged = (name: string): string => {
    const tag = `_${sha256Hex(name).slice(0, 4)}`
    return prefix + cleanName(name).slice(0, Math.max(0, EXPOSED_NAME_MAX - prefix.length - tag.length)) + tag
  }
  const groups = new Map<string, string[]>()
  for (const name of new Set(tools.map((t) => t.name))) {
    const plain = prefix + cleanName(name)
    groups.set(plain, [...(groups.get(plain) ?? []), name])
  }
  const out = new Map<string, string>()
  for (const [plain, names] of groups) {
    for (const name of names) {
      const keeps = plain.length <= EXPOSED_NAME_MAX && (names.length === 1 || cleanName(name) === name)
      out.set(name, keeps ? plain : tagged(name))
    }
  }
  return out
}

// ── the approval cards ──────────────────────────────────────────────────

/** Cards only a person with an admin key may allow. */
export const ADMIN_APPROVALS = ['addon_add'] as const
/** What the card shows in Allow's place on a socket without admin. */
export const ADDON_ADMIN_LINE = 'Needs an admin key'
/** The answer to an allow that `mayAllow` refuses. */
export const ADDON_APPROVE_REFUSAL = 'forbidden: approving an add-on needs a person with an admin key'

/** The tool's own name, whether the claude path (`mcp__app__addon_add`) or the bridge (`addon_add`) asked. */
const bareTool = (toolName: string): string => toolName.replace(/^mcp__app__/, '')
export const approvalNeedsAdmin = (toolName: string): boolean => (ADMIN_APPROVALS as readonly string[]).includes(bareTool(toolName))

/** Who is answering a card: the local socket, a remote key with its capabilities, or a model (a parent's answer_agent, an MCP key's prompt). */
export type ApprovalBy = { kind: 'local' } | { kind: 'remote'; caps: readonly string[] } | { kind: 'model' }

/** Whether `by` may ALLOW a card raised by `toolName`; a deny always passes and never asks. */
export function mayAllow(toolName: string | null | undefined, by: ApprovalBy): boolean {
  if (!toolName || !approvalNeedsAdmin(toolName)) return true
  if (by.kind === 'local') return true
  if (by.kind === 'remote') return by.caps.includes('admin')
  return false
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/
/** An argument as a shell would need it: bare when it can be, else single-quoted. */
export const shellQuote = (arg: string): string => (SAFE_ARG.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)

/** "A", "A and B", "A, B and C". */
export const andList = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export interface AddonCard {
  title: string
  /** In this key order: what runs or is reached, the scope, the hosts, what the grant needs, the note. */
  input: { runs: string; where: string; hosts: string; needs: string; note: string }
}

/** The names whose values the grant holds: env (less tokenEnv) or headers, whenever the add-on has a grant. */
export function grantFieldNames(spec: AddonSpec): string[] {
  if (spec.auth === 'none') return []
  return spec.transport === 'stdio' ? spec.env.filter((n) => n !== spec.tokenEnv) : [...spec.headers]
}

/** `addon_add`'s card. `workspaceName` null is every workspace; `replaces` when a row of that scope and name exists. */
export function addonCard(spec: AddonSpec, row: { name: string }, ctx: { workspaceName: string | null; replaces: boolean }): AddonCard {
  const fields = grantFieldNames(spec)
  const values = fields.length ? `values for ${andList(fields)}` : ''
  const needs =
    spec.auth === 'oauth' ? (values ? `A sign-in on the Mac and ${values}` : 'A sign-in on the Mac') : values ? values[0]!.toUpperCase() + values.slice(1) : 'Nothing'
  const platforms = new Set(spec.platforms ?? [])
  const hosts = platforms.size === 1 ? (platforms.has('darwin') ? 'Macs only' : 'Linux hosts only') : 'Every host'
  return {
    title: `${ctx.replaces ? 'Change' : 'Add'} the add-on ${row.name}`,
    input: {
      runs: spec.transport === 'stdio' ? [spec.command, ...spec.args].map(shellQuote).join(' ') : spec.url,
      where: scopeWords(ctx.workspaceName),
      hosts,
      needs,
      note: spec.transport === 'stdio' ? 'It runs as you on every host that starts it.' : 'Its tools send requests to this address.'
    }
  }
}

/** `addon_remove`'s card, asked unless a thread wrote the add-on last. */
export function addonRemoveCard(row: { name: string; addedBy: Writer }, ctx: { workspaceName: string | null }): { title: string; input: { where: string; addedBy: string } } {
  return { title: `Remove the add-on ${row.name}`, input: { where: scopeWords(ctx.workspaceName), addedBy: writerWords(row.addedBy) } }
}

/** Whether removing a row asks the person: it does unless a thread wrote it last. */
export const removeAsks = (row: { writtenBy: Writer }): boolean => row.writtenBy.kind !== 'thread'

// ── the tools threads get (section 7 of the schema plan) ────────────────
// The registry core registers these on the claude path and the bridge;
// scripts/app-mcp-bridge.mjs keeps copies that app-bridge.test.ts holds equal.

export const ADDON_LIST_TOOL = 'addon_list'
export const ADDON_LIST_DESCRIPTION =
  'List the add-ons this thread can use: each one\'s name, where it applies, what it runs or reaches, its state on this host and how many tools it has. An add-on\'s tools are named `<add-on>__<tool>`.'
export const ADDON_LIST_CLAUDE_TAIL = 'Find them with tool search.'
export const ADDON_LIST_BRIDGE_TAIL = 'addon_find lists them and addon_call runs one.'

export const ADDON_ADD_TOOL = 'addon_add'
export const ADDON_ADD_DESCRIPTION =
  'Add an MCP server as an add-on that every thread in its scope can use, or replace the one of the same name. A person with an admin key approves it on a card first, since a stdio command runs as them on every host that starts it. Never put a secret in `command`, `args` or `url`: name the variable in `env` (stdio) or the header in `headers` (http), and the person enters its value in the add-on\'s grant on Settings → Add-ons; `auth: "oauth"` asks them to sign in instead. Scope defaults to this thread\'s workspace. Threads that start after it is ready list its tools.'
export const ADDON_ADD_PARAMS = {
  name: 'Lowercase letters, digits and dashes, at most 20 characters; every tool name starts with it (`github__create_issue`).',
  description: 'One line on what it is for; tool search and the Add-ons page show it.',
  transport: 'stdio: the app runs `command` with `args` on each host. http: the app connects to `url`.',
  command: 'stdio: the program to run, e.g. `npx`.',
  args: 'stdio: its arguments, e.g. ["-y", "@modelcontextprotocol/server-github"]. No secrets.',
  env: 'stdio: names of the variables it needs, e.g. ["GITHUB_TOKEN"]. Their values live in the add-on\'s grant, never here.',
  tokenEnv: 'stdio with auth oauth: the variable that gets the sign-in\'s access token.',
  url: 'http: the server\'s address; https, or plain http only to this machine.',
  headers: 'http: names of the headers it needs, e.g. ["X-Api-Key"]. Their values live in the add-on\'s grant.',
  auth: 'none (default); fields: the person enters the values env or headers name; oauth: the person signs in on the Mac.',
  scope: 'workspace (default): threads in this thread\'s workspace. global: every thread.',
  platforms: 'Hosts it runs on when it needs one kind: ["darwin"] for Macs, ["linux"]. Default: every host.'
} as const

export const ADDON_REMOVE_TOOL = 'addon_remove'
export const ADDON_REMOVE_DESCRIPTION =
  'Remove an add-on by name. Removing one that a person added or last changed asks them first. Its grant goes with it.'
export const ADDON_REMOVE_PARAMS = {
  name: 'The add-on\'s name.',
  scope: 'workspace (default): the one in this thread\'s workspace. global: the one every thread sees.'
} as const

export const ADDON_FIND_TOOL = 'addon_find'
export const ADDON_FIND_DESCRIPTION =
  'Find add-on tools by words in their names and descriptions. Answers up to ten, each with its name and input schema, ready for addon_call. With no query, every add-on\'s tools by name.'
export const ADDON_FIND_PARAMS = {
  query: 'Words to look for in tool names and descriptions.',
  addon: 'Only this add-on\'s tools.'
} as const

export const ADDON_CALL_TOOL = 'addon_call'
export const ADDON_CALL_DESCRIPTION =
  'Run one add-on tool by the name addon_find gave (`<add-on>__<tool>`) with its arguments. It follows this thread\'s permission: a tool that changes things may ask the person first.'
export const ADDON_CALL_PARAMS = {
  tool: 'The tool\'s name as addon_find gave it: `<add-on>__<tool>`.',
  arguments: 'The tool\'s arguments, matching its input schema.'
} as const
