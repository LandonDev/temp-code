import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ServiceId } from 'aliax-core'
import { whenLoopIdle } from './stalls'
import type { AccountHeadroom } from '@shared/accounts'

/**
 * What the gateway sees of each account's rate limits, per host.
 *
 * Every upstream answer the gateway forwards carries the provider's
 * per-request limits: Anthropic's `anthropic-ratelimit-{requests,tokens,
 * input-tokens,output-tokens}-{limit,remaining,reset}` (reset is RFC 3339)
 * plus the unified status and representative claim, OpenAI's
 * `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` (reset is a Go
 * duration, "6m0s"), and `retry-after` on a 429. This store keeps the newest
 * of each per account, the timestamps of the last minute's answers (the
 * request rate), and every 429 or 529 with the time it lifts. Each host
 * keeps its own observations under its environment id and merges what the
 * other hosts push (`accounts.headroom`, remote/accountSync.ts), so the Mac
 * and the box score from the same picture. A small snapshot is written to
 * `<dataDir>/headroom.json` so a relaunch is not blind.
 *
 * The usage windows (5h, Weekly, Fable) are not here: aliax-core's reports
 * carry those, and the score (accountScore.ts) reads both.
 */

export const RATE_WINDOW_MS = 60_000
/** A 429 without a retry-after or a reset keeps the account out for this long. */
export const THROTTLE_DEFAULT_MS = 60_000
/** An overloaded (529) answer says nothing about when; this is the pause. */
export const OVERLOADED_MS = 30_000
/** Throttle events kept per account, per host. */
const THROTTLES_KEPT = 20
/** An observation older than this is dropped at load and never merged in. */
const OBSERVATION_TTL_MS = 24 * 3_600_000
const SAVE_DEBOUNCE_MS = 5_000
export const SNAPSHOT_VERSION = 1

export interface LimitField {
  limit?: number
  remaining?: number
  resetsAt?: number
}

export interface ThrottleEvent {
  at: number
  status: number
  until: number
  model: string | null
}

/** One host's view of one account. */
export interface HostObservation {
  /** The newest answer this host saw from the account. */
  seenAt: number
  requests?: LimitField
  tokens?: LimitField
  inputTokens?: LimitField
  outputTokens?: LimitField
  /** Anthropic's unified status (allowed, allowed_warning, rejected) or representative claim, OpenAI's nothing. */
  tier?: string
  /** Answer timestamps inside the rate window, oldest first. */
  recent: number[]
  /** 429 and 529 answers, oldest first. */
  throttles: ThrottleEvent[]
}

export type AccountKey = `${ServiceId}:${string}`

export interface HeadroomSnapshot {
  version: typeof SNAPSHOT_VERSION
  /** By environment id, then by `service:account`. */
  hosts: Record<string, Record<string, HostObservation>>
}

export interface ObserveInput {
  service: ServiceId
  account: string
  model: string | null
  status: number
  headers: Pick<Headers, 'get'>
  now?: number
}

export interface HeadroomDeps {
  environmentId: string
  /** Where the snapshot lives; absent keeps everything in memory (tests). */
  file?: string
  now?: () => number
  /** A 429 or 529 landed: the host pushes its picture at once and re-picks. */
  onThrottle?: (service: ServiceId, account: string, event: ThrottleEvent) => void
  log?: (line: string) => void
}

export const accountKey = (service: ServiceId, account: string): AccountKey => `${service}:${account}`

const LIMIT_FIELDS = ['requests', 'tokens', 'inputTokens', 'outputTokens'] as const
type LimitName = (typeof LIMIT_FIELDS)[number]

/** Anthropic's header stems and OpenAI's suffixes for each field. */
const ANTHROPIC_STEMS: Record<LimitName, string> = { requests: 'requests', tokens: 'tokens', inputTokens: 'input-tokens', outputTokens: 'output-tokens' }
const OPENAI_SUFFIXES: Partial<Record<LimitName, string>> = { requests: 'requests', tokens: 'tokens' }

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** RFC 3339 or an epoch in seconds/ms; undefined when neither. */
export function parseResetAt(v: string | null, now: number): number | undefined {
  if (v === null || v.trim() === '') return undefined
  const asNumber = Number(v)
  if (Number.isFinite(asNumber)) {
    // A small number is seconds from now (retry-after's shape), a big one an epoch.
    if (asNumber < 1e9) return now + asNumber * 1000
    return asNumber < 1e12 ? asNumber * 1000 : asNumber
  }
  const parsed = Date.parse(v)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** OpenAI's Go-style duration ("6m0s", "1.5s", "20ms", "1h2m3s") in ms; undefined when it is not one. */
export function parseGoDuration(v: string | null): number | undefined {
  if (v === null) return undefined
  const text = v.trim()
  if (!text) return undefined
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g
  let total = 0
  let matched = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    matched += m[0].length
    const n = Number(m[1])
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n
  }
  return matched === text.length && matched > 0 ? total : undefined
}

/** `retry-after`: seconds, or an HTTP date. */
export function parseRetryAfter(v: string | null, now: number): number | undefined {
  if (v === null || v.trim() === '') return undefined
  const secs = Number(v)
  if (Number.isFinite(secs)) return now + Math.max(0, secs) * 1000
  const date = Date.parse(v)
  return Number.isFinite(date) ? date : undefined
}

/** The per-request limits one answer's headers carry, Anthropic's or OpenAI's; empty when it carries none. */
export function parseLimitHeaders(headers: Pick<Headers, 'get'>, now: number): Partial<Record<LimitName, LimitField>> & { tier?: string } {
  const out: Partial<Record<LimitName, LimitField>> & { tier?: string } = {}
  for (const name of LIMIT_FIELDS) {
    const stem = `anthropic-ratelimit-${ANTHROPIC_STEMS[name]}`
    const limit = num(headers.get(`${stem}-limit`))
    const remaining = num(headers.get(`${stem}-remaining`))
    const resetsAt = parseResetAt(headers.get(`${stem}-reset`), now)
    if (limit !== undefined || remaining !== undefined) out[name] = { limit, remaining, resetsAt }
  }
  for (const name of LIMIT_FIELDS) {
    const suffix = OPENAI_SUFFIXES[name]
    if (!suffix || out[name]) continue
    const limit = num(headers.get(`x-ratelimit-limit-${suffix}`))
    const remaining = num(headers.get(`x-ratelimit-remaining-${suffix}`))
    const reset = headers.get(`x-ratelimit-reset-${suffix}`)
    const after = parseGoDuration(reset)
    const resetsAt = after !== undefined ? now + after : parseResetAt(reset, now)
    if (limit !== undefined || remaining !== undefined) out[name] = { limit, remaining, resetsAt }
  }
  const status = headers.get('anthropic-ratelimit-unified-status')
  const claim = headers.get('anthropic-ratelimit-unified-representative-claim')
  const tier = [status, claim].filter((s): s is string => !!s).join(' · ')
  if (tier) out.tier = tier
  return out
}

/** When a 429/529 lifts: retry-after, else the soonest reset of an exhausted field, else the unified reset, else a default. */
export function throttleUntil(status: number, headers: Pick<Headers, 'get'>, fields: Partial<Record<LimitName, LimitField>>, now: number): number {
  const after = parseRetryAfter(headers.get('retry-after'), now)
  if (after !== undefined && after > now) return after
  if (status === 529) return now + OVERLOADED_MS
  const exhausted = LIMIT_FIELDS.map((n) => fields[n])
    .filter((f): f is LimitField => !!f && f.remaining === 0 && f.resetsAt !== undefined && f.resetsAt! > now)
    .map((f) => f.resetsAt!)
  if (exhausted.length) return Math.min(...exhausted)
  const unified = parseResetAt(headers.get('anthropic-ratelimit-unified-reset'), now)
  if (unified !== undefined && unified > now) return unified
  return now + THROTTLE_DEFAULT_MS
}

const emptyObservation = (now: number): HostObservation => ({ seenAt: now, recent: [], throttles: [] })

export class HeadroomStore {
  private readonly hosts = new Map<string, Map<string, HostObservation>>()
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(private readonly deps: HeadroomDeps) {
    this.load()
  }

  get me(): string {
    return this.deps.environmentId
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private mine(): Map<string, HostObservation> {
    let m = this.hosts.get(this.me)
    if (!m) this.hosts.set(this.me, (m = new Map()))
    return m
  }

  /** One upstream answer, as the gateway's onResponse hands it over. */
  observe({ service, account, model, status, headers, now = this.now() }: ObserveInput): void {
    const key = accountKey(service, account)
    const mine = this.mine()
    const prior = mine.get(key) ?? emptyObservation(now)
    const parsed = parseLimitHeaders(headers, now)
    const next: HostObservation = { ...prior, seenAt: Math.max(prior.seenAt, now) }
    for (const name of LIMIT_FIELDS) if (parsed[name]) next[name] = parsed[name]
    if (parsed.tier) next.tier = parsed.tier
    next.recent = [...prior.recent.filter((t) => now - t < RATE_WINDOW_MS), now]
    if (status === 429 || status === 529) {
      const event: ThrottleEvent = { at: now, status, until: throttleUntil(status, headers, parsed, now), model }
      next.throttles = [...prior.throttles, event].slice(-THROTTLES_KEPT)
      mine.set(key, next)
      this.touched()
      this.deps.onThrottle?.(service, account, event)
      return
    }
    mine.set(key, next)
    this.touched()
  }

  /** Forget a host's observations of an account (the account left the vault). */
  forget(service: ServiceId, account: string): void {
    const key = accountKey(service, account)
    for (const m of this.hosts.values()) m.delete(key)
    this.touched()
  }

  /**
   * Another host's picture. Only what that host saw of itself is taken (the
   * sender's own entry), never its copy of ours or of a third host's: each
   * host is the authority on its own gateway.
   */
  merge(from: string, snapshot: HeadroomSnapshot | null | undefined): boolean {
    if (!snapshot || snapshot.version !== SNAPSHOT_VERSION || from === this.me) return false
    const theirs = snapshot.hosts?.[from]
    if (!theirs) return false
    const now = this.now()
    const mine = this.hosts.get(from) ?? new Map<string, HostObservation>()
    let changed = false
    for (const [key, obs] of Object.entries(theirs)) {
      if (!isObservation(obs) || now - obs.seenAt > OBSERVATION_TTL_MS) continue
      const have = mine.get(key)
      if (have && have.seenAt >= obs.seenAt && have.throttles.length >= obs.throttles.length) continue
      mine.set(key, trim(obs, now))
      changed = true
    }
    if (changed) {
      this.hosts.set(from, mine)
      this.touched()
    }
    return changed
  }

  /** This host's own observations, the shape the peer push carries. */
  own(): HeadroomSnapshot {
    return { version: SNAPSHOT_VERSION, hosts: { [this.me]: Object.fromEntries(this.mine()) } }
  }

  /** Everything, every host: what the file holds. */
  snapshot(): HeadroomSnapshot {
    const hosts: HeadroomSnapshot['hosts'] = {}
    for (const [host, m] of this.hosts) hosts[host] = Object.fromEntries(m)
    return { version: SNAPSHOT_VERSION, hosts }
  }

  /** The merged picture of one account across hosts. */
  view(service: ServiceId, account: string, now = this.now()): AccountHeadroom {
    const key = accountKey(service, account)
    const observations = [...this.hosts.values()].map((m) => m.get(key)).filter((o): o is HostObservation => !!o)
    return mergeViews(observations, now)
  }

  /** Every account any host has seen for a service, for the snapshot the renderer paints. */
  summary(service: ServiceId, accounts: string[], now = this.now()): Record<string, AccountHeadroom> {
    const out: Record<string, AccountHeadroom> = {}
    for (const name of accounts) out[name] = this.view(service, name, now)
    return out
  }

  /** The accounts of a service a 429 or 529 keeps out right now. */
  throttled(service: ServiceId, accounts: string[], now = this.now()): string[] {
    return accounts.filter((a) => (this.view(service, a, now).throttledUntil ?? 0) > now)
  }

  private touched(): void {
    this.dirty = true
    if (!this.deps.file || this.saveTimer) return
    // The write waits for a quiet loop; flush() clears the timer.
    this.saveTimer = setTimeout(() => whenLoopIdle(() => this.flush()), SAVE_DEBOUNCE_MS)
    this.saveTimer.unref()
  }

  /** Write the snapshot now (before-quit, tests). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.deps.file || !this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const tmp = `${this.deps.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.snapshot()))
      renameSync(tmp, this.deps.file)
    } catch (e) {
      this.deps.log?.(`could not write ${this.deps.file}: ${(e as Error).message}`)
    }
  }

  private load(): void {
    if (!this.deps.file) return
    let parsed: HeadroomSnapshot
    try {
      parsed = JSON.parse(readFileSync(this.deps.file, 'utf8')) as HeadroomSnapshot
    } catch {
      return
    }
    if (!parsed || parsed.version !== SNAPSHOT_VERSION || typeof parsed.hosts !== 'object') return
    const now = this.now()
    for (const [host, entries] of Object.entries(parsed.hosts ?? {})) {
      const m = new Map<string, HostObservation>()
      for (const [key, obs] of Object.entries(entries ?? {})) {
        if (!isObservation(obs) || now - obs.seenAt > OBSERVATION_TTL_MS) continue
        m.set(key, trim(obs, now))
      }
      if (m.size) this.hosts.set(host, m)
    }
  }
}

function isObservation(v: unknown): v is HostObservation {
  if (!v || typeof v !== 'object') return false
  const o = v as HostObservation
  return typeof o.seenAt === 'number' && Array.isArray(o.recent) && Array.isArray(o.throttles)
}

/** Drop what time has made worthless: answers outside the rate window, throttles that lifted an hour ago. */
function trim(obs: HostObservation, now: number): HostObservation {
  return {
    ...obs,
    recent: obs.recent.filter((t) => typeof t === 'number' && now - t < RATE_WINDOW_MS),
    throttles: obs.throttles.filter((t) => t && typeof t.until === 'number' && t.until > now - 3_600_000).slice(-THROTTLES_KEPT)
  }
}

/** The merged view: the newest observation wins each field, rates add, the furthest throttle holds. */
export function mergeViews(observations: HostObservation[], now: number): AccountHeadroom {
  if (observations.length === 0) return { room: null, ratePerMin: 0, seenAt: null }
  const byNewest = [...observations].sort((a, b) => b.seenAt - a.seenAt)
  let room: number | null = null
  let resetsAt: number | undefined
  for (const name of LIMIT_FIELDS) {
    const field = byNewest.find((o) => o[name])?.[name]
    if (!field || field.limit === undefined || field.limit <= 0 || field.remaining === undefined) continue
    // A field whose reset has passed refilled: full room, and its old numbers say nothing.
    if (field.resetsAt !== undefined && field.resetsAt <= now) continue
    const share = Math.max(0, Math.min(1, field.remaining / field.limit))
    if (room === null || share < room) {
      room = share
      resetsAt = field.resetsAt
    }
  }
  let ratePerMin = 0
  for (const o of observations) ratePerMin += o.recent.filter((t) => now - t < RATE_WINDOW_MS).length
  let throttledUntil: number | undefined
  for (const o of observations) for (const t of o.throttles) if (t.until > now && (throttledUntil === undefined || t.until > throttledUntil)) throttledUntil = t.until
  const out: AccountHeadroom = { room, ratePerMin, seenAt: byNewest[0].seenAt }
  if (resetsAt !== undefined) out.resetsAt = resetsAt
  if (throttledUntil !== undefined) out.throttledUntil = throttledUntil
  const tier = byNewest.find((o) => o.tier)?.tier
  if (tier) out.tier = tier
  return out
}
