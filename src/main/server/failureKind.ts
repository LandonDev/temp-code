import type { Failure, FailureKind, LimitWindow } from '@shared/events'
import type { ProviderId } from '@shared/catalog'

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
const TOKEN_EXPIRED = /token_expired/i
const QUOTA = /out of credits|insufficient[_ ]credits|credit balance|insufficient_quota|billing|exceeded your current quota|no credits/i
const RATE_LIMITED = /rate[ _-]?limit|too many requests|usage limit|\b429\b|overloaded_error|overloaded|hit your limit|reached (your|the) (usage )?limit/i
const MODEL_UNAVAILABLE =
  /model[^.\n]{0,40}(not found|does not exist|is not supported|not supported|unavailable|not available|is deprecated|has been retired)|not_found_error|unknown model|invalid model|minCodexVersion|no such model/i
const NETWORK =
  /econnrefused|econnreset|etimedout|enotfound|eai_again|epipe|ehostunreach|enetunreach|fetch failed|network error|connection error|socket hang up|getaddrinfo|stream disconnected|certificate|unable to verify|tls|dns|request timed out|timed out/i
const HARNESS_CRASHED =
  /harness stream ended mid-turn|exited unexpectedly|never reported the turn done|process exited|exited with code|exit code|\benoent\b|closed before|crashed|killed|sigkill|sigterm|out of memory|heap out of memory|the harness is gone|harness (was )?lost/i

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
  return 'unknown'
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
    case 'network':
      return {
        summary: `Could not reach ${provider}`,
        cause: 'The connection dropped or was refused: a network change here, or an outage on their side.'
      }
    case 'harness_crashed':
      return {
        summary: `The ${harness} process died mid-turn`,
        cause: 'Its stream ended before the turn finished; the conversation can pick up from its last message.'
      }
    case 'unknown':
      return { summary: 'The turn failed', cause: oneLine(ctx.message) || 'The harness gave no reason.' }
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
    const m = /token_expired|invalid_grant|authentication_error|rate_limit_error|overloaded_error|not_found_error|insufficient_quota/i.exec(body)
    return m ? m[0].toLowerCase() : null
  }
}
