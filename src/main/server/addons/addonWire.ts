import { andList } from '@shared/addons'
import type { AddonSpec, AddonStatus } from '@shared/contract-addons'
import type { Reply } from '../gatewayWire'

/**
 * What main and the add-on host's utility process say to each other over
 * one MessagePortMain (addonHost.ts ↔ addonChild.ts), on the gateway's
 * plumbing (gatewayWire.ts `Wire`, `Calls`, `answer`). Main owns the rows
 * and the grants; the child owns the downstream MCP clients. A grant value
 * crosses only as the answer to the child's `grant` ask: never in the start
 * state, a launch, an event or a log line.
 */

/** One add-on the host should run: the row's facts, never a secret. */
export interface AddonLaunch {
  id: string
  name: string
  spec: AddonSpec
  /** sha256 of the canonical spec JSON: a change restarts the client and voids the tool cache */
  specDigest: string
}

export interface AddonStartState {
  mainPid: number
  /** The environment every stdio server starts from: only the keys of ADDON_BASE_ENV_KEYS (PATH as harnessEnv() resolves it) plus the guard's instance mark. Never the app's own environment whole (it holds the app's credentials), never a grant value. */
  baseEnv: Record<string, string>
  /** Where a stdio server starts: the host's work root, else home. */
  cwd: string
  launches: AddonLaunch[]
  /** TEMP_CODE_ADDON_TRACE=1: one line per connect, list, call and exit, never an argument value or a header value */
  trace: boolean
}

/** A grant as main resolves it for one add-on (grants.ts resolveGrant). Crosses the port only; never logged, never on disk. */
export type ResolvedGrant =
  | { ok: true; env: Record<string, string>; headers: Record<string, string>; digest: string }
  | { ok: false; gaps: string[] }

/** A downstream tool as the server listed it. */
export interface DownstreamTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly?: boolean
}

/** An MCP CallToolResult, passed through whole (text, image, audio, resource parts; isError; structuredContent). */
export type AddonCallResult = { content: unknown[]; isError?: boolean; structuredContent?: unknown }

/** What main asks the child, answered with `reply`. */
export type AddonChildCall =
  | { m: 'call'; addonId: string; tool: string; arguments: Record<string, unknown>; callId: string; timeoutMs: number }
  | { m: 'cancel'; callId: string }
  | { m: 'restart'; addonId: string }

/** What the child asks main, answered with `reply`. */
export type AddonMainCall = { m: 'grant'; addonId: string }

/** What the child tells main, unanswered. */
export type AddonChildEvent =
  | { e: 'status'; addonId: string; status: AddonStatus }
  | { e: 'tools'; addonId: string; specDigest: string; tools: DownstreamTool[] }
  /** an http server answered 401 or 403: main asks the grant source to refresh, then drops the grant */
  | { e: 'unauthorized'; addonId: string }

export type AddonWireMessage =
  // main → child
  | { t: 'start'; state: AddonStartState }
  /** The whole set this host should run: the child starts what is new, stops what is gone, restarts what changed (specDigest). */
  | { t: 'launches'; launches: AddonLaunch[] }
  /** Forget the kept grant of one add-on, or of every one for null: its client asks again and restarts if the values changed. */
  | { t: 'grants.drop'; addonId: string | null }
  | { t: 'ask'; id: number; call: AddonChildCall | AddonMainCall }
  // child → main
  | { t: 'ready'; pid: number }
  | { t: 'event'; event: AddonChildEvent }
  // both ways
  | Reply

export const ADDON_CONNECT_TIMEOUT_MS = 30_000 // spawn or dial, initialize, the first tools/list
export const ADDON_CALL_TIMEOUT_MS = 10 * 60_000 // one tools/call, host side; the bridge waits on the host
export const ADDON_GRANT_TIMEOUT_MS = 30_000 // the child's grant ask (gatewayWire's credential deadline)
export const ADDON_RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000] // then 60 s each time
export const ADDON_STABLE_MS = 60_000 // up this long: the backoff starts over
export const ADDON_RESULT_MAX_BYTES = 16 * 1024 * 1024
export const ADDON_MAX_TOOLS = 256
export const ADDON_HOST_EXIT_WINDOW_MS = 60_000
export const ADDON_HOST_EXITS_BEFORE_DOWN = 3
export const ADDON_HOST_RETRY_MS = 10 * 60_000 // a host that went down is tried once more after this
export const ADDON_MARK = 'TEMP_CODE_ADDON' // env mark on every stdio server: the add-on's id
/** What a stdio server inherits of the host's environment; anything else it needs is a grant field. */
export const ADDON_BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'] as const
/** The codex first-turn gate may grow by at most this with add-ons in scope (the e2e's step 8). */
export const ADDON_GATE_BUDGET_MS = 250

/** The `needs-grant` detail of the statuses this build sets; the settings pages read these words. */
export const GRANT_REFUSED_LINE = 'The server refused the grant'

/** grantGaps() in the card's words with "Needs " in front: `Needs values for FAKE_TOKEN and X-Api-Key`, `Needs a sign-in on the Mac`. */
export function grantGapsLine(gaps: readonly string[]): string {
  const fields = gaps.filter((g) => g !== 'sign-in')
  const values = fields.length ? `values for ${andList(fields)}` : ''
  if (gaps.includes('sign-in')) return values ? `Needs a sign-in on the Mac and ${values}` : 'Needs a sign-in on the Mac'
  return values ? `Needs ${values}` : 'Needs nothing'
}

/** A size in the result cap's words: `16.5 MB`. */
export const megabytes = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
