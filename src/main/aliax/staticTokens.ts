import {
  accounts,
  checkMinted,
  exchangeCodeForStatic,
  hasRefresh,
  INFERENCE_ONLY_SCOPES,
  mintStaticFromRefresh,
  ownsProfile,
  saveStaticClaude,
  STATIC_SCOPES,
  staticRenewalDue,
  staticTokenOf,
  vault,
  type ActionResult,
  type MintedToken,
  type PlainCookie
} from 'aliax-core'
import type { MintProgress, MintState } from '@shared/accounts'
import type { SessionMintInput, SessionMintResult } from './staticMint'

/**
 * Every Claude account a one-year token, held by every host (T1): the
 * conversions the Accounts page asks for and the renewals nobody asks for.
 *
 * One account at a time, two routes:
 *  1. the refresh grant this host holds (aliax-core mintStaticFromRefresh):
 *     a refresh_token grant with `expires_in` for a year, no browser, the
 *     grant dropped only once the token is verified and filed. A grant
 *     another host refreshes is taken back first over the peer link (the
 *     takeOver pull `accounts.setHome` uses: provisional landing, confirm,
 *     the owner strips); a host out of reach leaves route 2 to run, and the
 *     row's reason names the host when that fails too;
 *  2. the account's stored claude.ai session in a hidden window
 *     (staticMint.ts): the consent page approves without a sign-in. When
 *     the session has lapsed, a run the user started opens the ordinary
 *     in-app sign-in with the address pre-filled and the stored cookies; a renewal says
 *     `needs-sign-in` instead and the row carries that word.
 * The token response names its account (uuid, email): a token is filed only
 * under the row it belongs to, or refused by name. A token that did not get
 * the year with `user:profile` is asked for again with `user:inference`
 * alone, the way the CLI asks.
 *
 * Renewal starts 30 days before a token lapses: on boot and every six
 * hours, each static token inside the window is minted again through its
 * stored session, once a day at most while that fails. The sync pushes a
 * new token to every other host as it does any static profile.
 */

export interface StaticTokenDeps {
  /** The browser half; injected so this module never imports electron. */
  mintInWindow: (input: SessionMintInput) => Promise<SessionMintResult>
  /** Rebuild and push the accounts snapshot (the rows read their state from it). */
  nudge: () => void
  /** Every window redraws its Accounts page. */
  changed: () => void
  /** The account sync: a new token reaches the other hosts at once. */
  syncAll: () => Promise<void>
  /** The account sync: the grant back from the host that refreshes it (AccountSync.takeBack). Null once this host holds it, else why not, naming the host. */
  takeBack: (name: string, owner: string) => Promise<string | null>
  log?: (line: string) => void
  now?: () => number
  /** Who a claude.ai session belongs to, for a token response that named no account. */
  sessionEmail?: (cookies: PlainCookie[]) => Promise<string | null>
  mintFromRefresh?: typeof mintStaticFromRefresh
  exchange?: typeof exchangeCodeForStatic
  /** Renewal cadence seams. */
  firstRenewDelayMs?: number
  renewEveryMs?: number
  /** A failed renewal is not tried again before this. */
  retryAfterMs?: number
}

export const RENEW_FIRST_DELAY_MS = 60_000
export const RENEW_EVERY_MS = 6 * 3_600_000
export const RENEW_RETRY_MS = 24 * 3_600_000

type Outcome = { state: 'done'; expiresAt: number } | { state: 'needs-sign-in' | 'failed'; detail: string } | { state: 'cancelled' }

export class StaticTokens {
  private readonly rows = new Map<string, MintState>()
  private run: { total: number; done: number } | null = null
  private running: Promise<unknown> | null = null
  private readonly lastAttempt = new Map<string, number>()
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly deps: StaticTokenDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[static-tokens] ${l}`)))(line)
  }

  /** What the rows show: each account's mint state, and the run under way. */
  progress(): MintProgress | null {
    if (this.rows.size === 0 && !this.run) return null
    return { rows: Object.fromEntries(this.rows), run: this.run }
  }

  private set(name: string, state: MintState | null): void {
    if (state) this.rows.set(name, state)
    else this.rows.delete(name)
    this.deps.nudge()
    this.deps.changed()
  }

  /** Accounts a conversion would touch: every Claude row not yet static, and every static one due for renewal. */
  candidates(): string[] {
    return vault
      .profiles('claude-code')
      .filter((p) => !p.static || staticRenewalDue(this.expiryOf(p.name), this.now()))
      .map((p) => p.name)
  }

  private expiryOf(name: string): number | undefined {
    try {
      const blob = vault.readSecret('claude-code', name)
      if (!blob) return undefined
      const exp = JSON.parse(JSON.parse(blob).keychain ?? '{}')?.claudeAiOauth?.expiresAt
      return typeof exp === 'number' ? exp : undefined
    } catch {
      return undefined
    }
  }

  /** One account, for the user: the hidden routes first, the in-app sign-in when the session has lapsed. */
  convert(name: string, interactive = true): Promise<ActionResult> {
    if (this.running) return Promise.resolve({ ok: false, error: 'a conversion is already running' })
    const work = this.one(name, interactive).then((out): ActionResult => {
      if (out.state === 'done') return { ok: true, name, notes: [`one-year token saved, lapses ${new Date(out.expiresAt).toLocaleDateString()}`] }
      if (out.state === 'cancelled') return { ok: false, error: 'sign-in cancelled' }
      return { ok: false, error: out.detail }
    })
    this.running = work.finally(() => (this.running = null))
    return work
  }

  /** Every candidate, one after another; a row that needs a sign-in opens the window when the user asked. */
  convertAll(interactive = true): Promise<ActionResult> {
    if (this.running) return Promise.resolve({ ok: false, error: 'a conversion is already running' })
    const work = (async (): Promise<ActionResult> => {
      const names = this.candidates()
      if (names.length === 0) return { ok: true, notes: ['every Claude account already holds a one-year token'] }
      this.run = { total: names.length, done: 0 }
      this.deps.nudge()
      const tally = { done: 0, signIn: 0, failed: 0, cancelled: 0 }
      try {
        for (const name of names) {
          const out = await this.one(name, interactive)
          if (out.state === 'done') tally.done++
          else if (out.state === 'needs-sign-in') tally.signIn++
          else if (out.state === 'cancelled') tally.cancelled++
          else tally.failed++
          this.run = { total: names.length, done: this.run!.done + 1 }
          this.deps.nudge()
        }
      } finally {
        this.run = null
        this.deps.nudge()
      }
      const notes = [
        `${tally.done} of ${names.length} converted`,
        tally.signIn ? `${tally.signIn} need a sign-in` : '',
        tally.failed ? `${tally.failed} failed` : '',
        tally.cancelled ? `${tally.cancelled} cancelled` : ''
      ].filter(Boolean)
      return tally.done === names.length ? { ok: true, notes } : { ok: false, error: notes.join(' · ') }
    })()
    this.running = work.finally(() => (this.running = null))
    return work
  }

  /** The scheduler's pass: every static token inside its renewal window, quietly, at most once a day each while it fails. */
  async renewDue(): Promise<void> {
    if (this.running) return
    const now = this.now()
    const retry = this.deps.retryAfterMs ?? RENEW_RETRY_MS
    const due = vault
      .profiles('claude-code')
      .filter((p) => p.static && staticRenewalDue(this.expiryOf(p.name), now) && now - (this.lastAttempt.get(p.name) ?? 0) >= retry)
      .map((p) => p.name)
    if (due.length === 0) return
    const work = (async (): Promise<void> => {
      for (const name of due) {
        this.lastAttempt.set(name, this.now())
        const out = await this.one(name, false)
        this.log(`${name}: renewal ${out.state}${'detail' in out ? ` (${out.detail})` : ''}`)
      }
    })()
    this.running = work.finally(() => (this.running = null))
    await work
  }

  start(): void {
    const first = setTimeout(() => void this.renewDue().catch((err) => this.log(`renewal pass failed (${(err as Error).message})`)), this.deps.firstRenewDelayMs ?? RENEW_FIRST_DELAY_MS)
    const every = setInterval(() => void this.renewDue().catch((err) => this.log(`renewal pass failed (${(err as Error).message})`)), this.deps.renewEveryMs ?? RENEW_EVERY_MS)
    first.unref()
    every.unref()
    this.timers.push(first, every)
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  private async one(name: string, interactive: boolean): Promise<Outcome> {
    this.set(name, { state: 'minting', at: this.now() })
    let out: Outcome
    try {
      out = await this.mint(name, interactive)
    } catch (err) {
      out = { state: 'failed', detail: (err as Error).message }
    }
    if (out.state === 'done') {
      accounts.clearUsageCache('claude-code', name)
      this.lastAttempt.delete(name)
      this.set(name, null)
      this.log(`${name}: one-year token filed, lapses ${new Date(out.expiresAt).toISOString().slice(0, 10)}`)
      void this.deps.syncAll().catch((err) => this.log(`${name}: sync after the mint failed (${(err as Error).message})`))
    } else if (out.state === 'cancelled') {
      this.set(name, null)
    } else {
      this.set(name, { state: out.state, at: this.now(), detail: out.detail })
      this.log(`${name}: ${out.state} (${out.detail})`)
    }
    return out
  }

  private async mint(name: string, interactive: boolean): Promise<Outcome> {
    let profile = this.profileOf(name)
    if (!profile) return { state: 'failed', detail: `no account named ${name}` }
    let blob = this.blobOf(name)
    const expected = { accountId: profile.accountId, email: profile.email }
    // Another host refreshes the grant: take it back first. Out of reach, the other routes run and the row says why the grant route was out.
    let elsewhere: string | null = null
    if (!profile.static && profile.owner && !ownsProfile(profile)) {
      elsewhere = await this.deps.takeBack(name, profile.owner)
      profile = this.profileOf(name) ?? profile
      blob = this.blobOf(name)
      this.log(elsewhere ? `${name}: ${elsewhere}; trying the stored claude.ai session` : `${name}: took the grant back; minting from it`)
    }
    if (!profile.static && blob && hasRefresh('claude-code', blob) && ownsProfile(profile)) {
      const out = await (this.deps.mintFromRefresh ?? mintStaticFromRefresh)(name, { now: () => this.now() })
      if (out.ok) return { state: 'done', expiresAt: out.minted.expiresAt }
      if (out.reason === 'wrong-account' || out.reason === 'no-account') return { state: 'failed', detail: out.detail }
      this.log(`${name}: the refresh grant did not yield a year (${out.detail}); trying the stored claude.ai session`)
    }
    const why = (detail: string): string => (elsewhere ? `${elsewhere}; ${detail}` : detail)

    const cookies = this.cookiesOf(blob)
    let result = cookies ? await this.deps.mintInWindow({ cookies, scopes: STATIC_SCOPES, visible: false }) : ({ kind: 'needs-sign-in', detail: 'no claude.ai session is stored for this account' } as SessionMintResult)
    if (result.kind === 'needs-sign-in') {
      if (!interactive) return { state: 'needs-sign-in', detail: why(result.detail) }
      this.log(`${name}: ${result.detail}; asking for a sign-in`)
      // The stored cookies ride along: a live session that did not approve in time needs the click, not a sign-in; a lapsed one lands on the login page as before.
      result = await this.deps.mintInWindow({ cookies, scopes: STATIC_SCOPES, loginHint: profile.email, visible: true })
      if (result.kind === 'closed') return { state: 'cancelled' }
      if (result.kind === 'needs-sign-in') return { state: 'needs-sign-in', detail: why(result.detail) }
    }
    if (result.kind !== 'code') return { state: 'cancelled' }

    const exchange = this.deps.exchange ?? exchangeCodeForStatic
    let minted: MintedToken = await exchange(result, { now: () => this.now() })
    let session = result.cookies
    let check = checkMinted(minted, expected, { now: this.now() })
    if (!check.ok && check.reason === 'short-lived') {
      // The pair with user:profile got no year: ask the same session for user:inference alone.
      this.log(`${name}: ${check.detail} with ${minted.scopes.join(' ')}; asking for user:inference alone`)
      const again = await this.deps.mintInWindow({ cookies: session.length ? session : cookies, scopes: INFERENCE_ONLY_SCOPES, visible: false })
      if (again.kind === 'code') {
        minted = await exchange(again, { now: () => this.now() })
        if (again.cookies.length) session = again.cookies
        check = checkMinted(minted, expected, { now: this.now() })
      }
    }
    if (!check.ok && check.reason === 'no-account') {
      // Inference-only servers may name nothing: the session the mint ran in says whose it is.
      const who = session.length && this.deps.sessionEmail ? await this.deps.sessionEmail(session).catch(() => null) : null
      if (who && expected.email && who.toLowerCase() === expected.email.toLowerCase()) check = { ok: true }
      else check = { ok: false, reason: 'no-account', detail: who ? `the session belongs to ${who}, not ${expected.email ?? expected.accountId}` : 'the token response named no account and the session could not say whose it is' }
    }
    if (!check.ok) return { state: 'failed', detail: why(check.detail) }
    saveStaticClaude({ ...staticTokenOf(minted, expected), appSession: session.length ? session : undefined })
    return { state: 'done', expiresAt: minted.expiresAt }
  }

  private profileOf(name: string) {
    return vault.profiles('claude-code').find((p) => p.name === name)
  }

  private blobOf(name: string): string | null {
    try {
      return vault.readSecret('claude-code', name)
    } catch {
      return null
    }
  }

  private cookiesOf(blob: string | null): PlainCookie[] | null {
    if (!blob) return null
    try {
      const cookies = (JSON.parse(blob) as { appSession?: PlainCookie[] | null }).appSession
      return Array.isArray(cookies) && cookies.some((c) => c.name === 'sessionKey') ? cookies : null
    } catch {
      return null
    }
  }
}
