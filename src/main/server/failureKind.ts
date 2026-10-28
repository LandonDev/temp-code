import type { Failure, FailureKind, LimitWindow } from '@shared/events'
import type { ProviderId } from '@shared/catalog'
import { isRoutedProvider, SIGN_IN_NAME } from '@shared/accounts'
import { fallbackFailure, TURN_ENDED_SUMMARY } from '@shared/failureFallback'
import { splitPath } from 'aliax-core'
import type { NetworkInfo } from './gatewayCore'

/**
 * Why a turn failed, decided here in main and never re-derived in a
 * renderer: the harness's own words, the gateway's last refusal for the
 * thread, and what the host knows about its routing (is the account still
 * on file, can the catalog offer the model) fold into one `Failure` the
 * error event carries. The card, the rail row and the phone print its two
 * lines; the action set per kind lives with the card.
 */

export interface GatewayRefusal {
  status: number
  /** The error code the upstream body named (`token_expired`, `invalid_grant`, …). */
  code: string | null
  account: string | null
  /** A gateway deadline, kept even when the harness only reports a cut stream. */
  timeout?: { stage: 'headers' | 'body' | 'total'; timeoutMs: number }
}

function upstreamTimeoutOf(message: string): GatewayRefusal['timeout'] {
  const match = /Upstream (headers|body|total) timed out after (\d+) ms/i.exec(message)
  return match ? { stage: match[1].toLowerCase() as 'headers' | 'body' | 'total', timeoutMs: Number(match[2]) } : undefined
}

/** Carry the gateway's stage to the registry without keeping the error text. */
export function networkRefusalOf(info: NetworkInfo): { thread: string; refusal: GatewayRefusal } | null {
  const { scope } = splitPath(info.path)
  if (!scope) return null
  const timeout = upstreamTimeoutOf(info.error)
  const credential = /credential_timeout/i.test(info.error)
  return {
    thread: scope.thread,
    refusal: { status: credential ? 503 : 502, code: credential ? 'credential_timeout' : null, account: info.account, ...(timeout ? { timeout } : {}) }
  }
}

export interface FailureContext {
  message: string
  provider: ProviderId
  model: string | null
  /** The account the turn was routed to, when the thread has one. */
  account: string | null
  /** Whether that account is on file here; null when the host cannot say. */
  accountKnown: boolean | null
  /** The limit the driver's text classifier found, when it did. */
  limit?: { window: LimitWindow } | null
  /** Whether the catalog offers the thread's model on this host. */
  modelVisible: boolean
  /** The gateway's last refusal for this thread, when recent. */
  gateway?: GatewayRefusal | null
}

const OAUTH_EXPIRED =
  /oauth session expired|could not be refreshed|oauth token (has )?expired|token (has been |was )?revoked|please run \/login|invalid api key|authentication_error|failed to authenticate|needs sign-in|not logged in|unauthorized|\(401\)|\b401\b/i
/** The CLI was never signed in, as opposed to a session that lapsed. */
const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|needs sign-in/i
const TOKEN_EXPIRED = /token_expired/i
const QUOTA = /out of credits|insufficient[_ ]credits|credit balance|insufficient_quota|billing|exceeded your current quota|no credits/i
const RATE_LIMITED = /rate[ _-]?limit|too many requests|usage limit|\b429\b|overloaded_error|overloaded|hit your limit|reached (your|the) (usage )?limit/i
const MODEL_UNAVAILABLE =
  /model[^.\n]{0,40}(not found|does not exist|is not supported|not supported|unavailable|not available|is deprecated|has been retired)|not_found_error|unknown model|invalid model|minCodexVersion|no such model/i
const NETWORK =
  /econnrefused|econnreset|etimedout|enotfound|eai_again|epipe|ehostunreach|enetunreach|fetch failed|network error|connection error|socket hang up|getaddrinfo|stream disconnected|certificate|unable to verify|tls|dns|request timed out|timed out/i
const HARNESS_CRASHED =
  /harness stream ended mid-turn|exited unexpectedly|never reported the turn done|process exited|exited with code|exit code|\benoent\b|closed before|crashed|killed|sigkill|sigterm|out of memory|heap out of memory|the harness is gone|harness (was )?lost/i
/** The claude driver's row for a result the CLI ended itself: the subtype,
 *  then the CLI's own first error line when it gave one. A stop is the
 *  same row stamped `stopped` by the registry and never reaches here. */
const TURN_ENDED = /^turn ended: (\w+)(?:: ([\s\S]*))?$/

const PROVIDER_NAME: Record<ProviderId, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  cursor: 'Cursor',
  grok: 'xAI',
  opencode: 'OpenCode',
  pi: 'Pi',
  omp: 'OMP',
  fx: 'FX'
}

const HARNESS_NAME: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor agent',
  grok: 'Grok',
  opencode: 'OpenCode',
  pi: 'Pi',
  omp: 'OMP',
  fx: 'FX'
}

/** What the sign-in is called where the account lives. */
function sessionName(provider: ProviderId): string {
  return provider === 'codex' ? 'ChatGPT sign-in' : `${PROVIDER_NAME[provider] ?? provider} session`
}

/** The kind alone: the precedence the two lines are written from. */
export function failureKindOf(ctx: FailureContext): FailureKind {
  const text = ctx.message
  // The host knows more than the words: an account gone from the vault
  // explains every 401 and every "no account" the harness reported.
  if (ctx.account && ctx.accountKnown === false) return 'account_unknown'
  const gateway = ctx.gateway ?? null
  if (gateway?.timeout || gateway?.code === 'credential_timeout' || /credential_timeout/i.test(text)) return 'network'
  if (gateway?.status === 401 && gateway.code && TOKEN_EXPIRED.test(gateway.code)) return 'token_expired'
  if (TOKEN_EXPIRED.test(text)) return 'token_expired'
  if (OAUTH_EXPIRED.test(text) || gateway?.status === 401 || gateway?.status === 403) return 'oauth_expired'
  // The driver's limit classifier read the message before we did: trust it.
  if (ctx.limit) return ctx.limit.window === 'credits' ? 'quota' : 'rate_limited'
  if (gateway?.status === 429) return QUOTA.test(text) ? 'quota' : 'rate_limited'
  if (QUOTA.test(text)) return 'quota'
  if (RATE_LIMITED.test(text)) return 'rate_limited'
  if (!ctx.modelVisible || MODEL_UNAVAILABLE.test(text)) return 'model_unavailable'
  if (gateway && gateway.status === 404) return 'model_unavailable'
  if (HARNESS_CRASHED.test(text)) return 'harness_crashed'
  if (NETWORK.test(text) || (gateway && gateway.status >= 500)) return 'network'
  // After the deaths and the network: a turn the CLI ended with a cause of
  // its own keeps that cause's kind.
  if (TURN_ENDED.test(text)) return 'turn_ended'
  return 'unknown'
}

/** Why the CLI ended the turn, when it gave no line of its own. */
function turnEndedCause(subtype: string, harness: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return "The CLI's turn limit was reached."
    case 'error_max_budget_usd':
      return "The CLI's spend limit was reached."
    case 'error_max_structured_output_retries':
      return 'The CLI gave up on a structured answer.'
    default:
      return `${harness} reported ${subtype || 'an error'} and gave no reason.`
  }
}

function limitLabel(window: LimitWindow | undefined): string {
  if (!window) return 'usage limit'
  if (typeof window === 'object') return `cap for ${window.model}`
  switch (window) {
    case '5h':
      return '5-hour limit'
    case 'weekly':
      return 'weekly limit'
    case 'transient':
      return 'per-minute limit'
    case 'credits':
      return 'credits'
  }
}

/** The raw message as one line, short enough for a card's second line. */
function oneLine(message: string, max = 160): string {
  const line = message.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The two lines for a kind: what happened (with the account) and why. */
export function describeFailure(kind: FailureKind, ctx: FailureContext): { summary: string; cause: string } {
  const account = ctx.account ?? ctx.gateway?.account ?? null
  const provider = PROVIDER_NAME[ctx.provider] ?? ctx.provider
  const harness = HARNESS_NAME[ctx.provider] ?? ctx.provider
  const model = ctx.model ?? 'The model'
  switch (kind) {
    case 'oauth_expired':
      if (!account && isRoutedProvider(ctx.provider) && NOT_SIGNED_IN.test(ctx.message)) {
        return { summary: `Not signed in to ${SIGN_IN_NAME[ctx.provider]}`, cause: 'No account on this host is signed in.' }
      }
      return {
        summary: account
          ? `${sessionName(ctx.provider)} for ${account} expired and could not be refreshed`
          : `The ${sessionName(ctx.provider)} expired and could not be refreshed`,
        cause: 'The stored sign-in lapsed and its refresh was refused; signing in again mints a new one.'
      }
    case 'account_unknown':
      return {
        summary: account ? `Account ${account} is no longer on file` : 'The account this thread used is no longer on file',
        cause: 'The account was removed or cancelled, so there is no sign-in to route this thread under.'
      }
    case 'token_expired':
      return {
        summary: account ? `The token for ${account} expired on this instance` : `The ${provider} token expired on this instance`,
        cause: 'This instance does not own the gateway and never refreshes tokens; the owner renews it on its next use.'
      }
    case 'rate_limited': {
      const label = limitLabel(ctx.limit?.window)
      return {
        summary: account ? `${account} hit its ${label}` : `${provider} answered with a ${label}`,
        cause: 'The usage window is spent until it resets; another account with room can take the thread.'
      }
    }
    case 'quota':
      return {
        summary: account ? `${account} is out of credits` : `The ${provider} plan is out of credits`,
        cause: 'The plan has nothing left to spend; top it up or route the thread to another account.'
      }
    case 'model_unavailable':
      return {
        summary: `${model} is not available on this host`,
        cause:
          ctx.provider === 'codex'
            ? 'The installed Codex CLI is older than the model needs (0.162.1 or newer), or the provider refused the model.'
            : 'The provider refused the model, or the catalog here does not offer it.'
      }
    case 'network': {
      if (ctx.gateway?.code === 'credential_timeout' || /credential_timeout/i.test(ctx.message)) {
        return { summary: 'The gateway could not get a credential in time', cause: 'The host did not answer the credential request within its deadline.' }
      }
      const timeout = ctx.gateway?.timeout ?? upstreamTimeoutOf(ctx.message)
      if (timeout) {
        const seconds = timeout.timeoutMs / 1000
        const summary = timeout.stage === 'headers'
          ? `No answer from the provider in ${seconds} s`
          : timeout.stage === 'body'
            ? `The provider stopped sending data for ${seconds} s`
            : `The provider request took longer than ${seconds} s`
        return { summary, cause: 'The gateway ended the request when its deadline passed.' }
      }
      return {
        summary: `Could not reach ${provider}`,
        cause: 'The connection dropped or was refused: a network change here, or an outage on their side.'
      }
    }
    case 'harness_crashed':
      return {
        summary: `The ${harness} process died mid-turn`,
        cause: 'The conversation can pick up from its last message.'
      }
    case 'turn_ended': {
      const [, subtype = '', line = ''] = TURN_ENDED.exec(ctx.message) ?? []
      return { summary: TURN_ENDED_SUMMARY, cause: line.trim() ? oneLine(line) : turnEndedCause(subtype, harness) }
    }
    case 'unknown': {
      // No reason at all reads as the renderer's fallback, word for word.
      const line = oneLine(ctx.message)
      if (!line) {
        const { summary, cause } = fallbackFailure()
        return { summary, cause }
      }
      return { summary: 'The turn failed', cause: line }
    }
  }
}

export function classifyFailure(ctx: FailureContext): Failure {
  const kind = failureKindOf(ctx)
  const { summary, cause } = describeFailure(kind, ctx)
  return { kind, account: ctx.account ?? ctx.gateway?.account ?? null, summary, cause }
}

/** The error code an upstream refusal's body names, if any (never the body itself). */
export function refusalCodeOf(body: string | undefined): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown } | string; code?: unknown; type?: unknown }
    const inner = typeof parsed.error === 'object' && parsed.error ? parsed.error : null
    const code = inner?.code ?? inner?.type ?? parsed.code ?? parsed.type ?? (typeof parsed.error === 'string' ? parsed.error : null)
    return typeof code === 'string' ? code : null
  } catch {
    const m = /credential_timeout|token_expired|invalid_grant|authentication_error|rate_limit_error|overloaded_error|not_found_error|insufficient_quota/i.exec(body)
    return m ? m[0].toLowerCase() : null
  }
}
