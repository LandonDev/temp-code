import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppRef } from '@shared/computer/protocol'
import type { PermissionPolicy, SessionMeta, SessionStatus } from '@shared/events'
import type { ApprovalRequest } from '../drivers/types'
import { renderText, type ComputerToolOutcome } from './result'
import { ComputerService } from './service'
import { ComputerSessions } from './sessions'
import { fakeServiceBin, type ManualClock } from './testFake'
import type { SessionTierGate } from './tierGate'

/**
 * The host over the fake service for the run, approval and rpc tests: a
 * registry that answers each thread's status and permission and holds cards
 * until the test decides them, a settings store in memory, the requests the
 * fake received.
 */
export interface Card {
  threadId: string
  req: ApprovalRequest
  decide: (allow: boolean) => void
}

export function computerHarness(
  opts: {
    env?: Record<string, string>
    gate?: SessionTierGate
    /** a gate that needs the service and the sessions (the scheduler) */
    makeGate?: (parts: { service: ComputerService; sessions: ComputerSessions }) => SessionTierGate
    resolveApp?: (q: string) => AppRef | null
    clock?: ManualClock
  } = {}
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tc-computer-run-'))
  const landingRoot = mkdtempSync(join(tmpdir(), 'tc-computer-landing-'))
  const log = join(dataDir, 'requests.log')
  const rows = new Map<string, string>()
  const store = {
    getSetting: (k: string) => rows.get(k) ?? null,
    setSetting: (k: string, v: string | null) => void (v === null ? rows.delete(k) : rows.set(k, v)),
    settingsWithPrefix: (p: string) => new Map([...rows].filter(([k]) => k.startsWith(p)))
  }
  const metas = new Map<string, { status: SessionStatus; permission: PermissionPolicy; provider?: string; model?: string }>()
  const cards: Card[] = []
  let away = false
  const registry = {
    get: (id: string) => ({ id, status: 'running', permission: 'auto', archived: false, ...metas.get(id) }) as unknown as SessionMeta,
    requestApproval: (threadId: string, req: ApprovalRequest) =>
      new Promise<boolean>((resolve) => {
        // the registry's Away rule (sessions.ts requestApproval): allowed, unless the card is a money act
        if (away) return resolve(!req.awayDenies)
        cards.push({ threadId, req, decide: resolve })
        req.signal?.addEventListener('abort', () => resolve(false), { once: true })
      }),
    awayOn: () => away
  }
  const service = new ComputerService({ dataDir, env: { ...process.env, FAKE_LOG: log, ...opts.env }, bin: () => fakeServiceBin(), log: () => undefined })
  let gate: SessionTierGate | undefined = opts.gate
  const sessions = new ComputerSessions({
    service,
    registry,
    store,
    dataDir,
    landing: (id) => join(landingRoot, id),
    gate: opts.gate || opts.makeGate ? () => gate! : undefined,
    resolveApp: opts.resolveApp,
    clock: opts.clock,
    log: () => undefined
  })
  if (opts.makeGate) gate = opts.makeGate({ service, sessions })
  const set = (threadId: string, meta: Partial<{ status: SessionStatus; permission: PermissionPolicy; provider: string; model: string }>): void => {
    const next = { status: 'running' as SessionStatus, permission: 'auto' as PermissionPolicy, ...metas.get(threadId), ...meta }
    metas.set(threadId, next)
    sessions.onMeta({ id: threadId, archived: false, ...next } as unknown as SessionMeta)
  }
  return {
    dataDir,
    landingRoot,
    store,
    rows,
    service,
    sessions,
    cards,
    set,
    setAway: (on: boolean) => (away = on),
    gate: () => gate,
    run: (tool: string, args: unknown, threadId = 't1', ctx: { signal?: AbortSignal; callId?: string } = {}): Promise<ComputerToolOutcome> =>
      sessions.run({ threadId, ...ctx }, tool, args),
    /** every request line the fake received, parsed, in order */
    requests: (): { id?: number; method: string; params: Record<string, unknown> }[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    text: (o: ComputerToolOutcome): string => renderText(o),
    close: () => service.close()
  }
}
export type ComputerHarness = ReturnType<typeof computerHarness>
