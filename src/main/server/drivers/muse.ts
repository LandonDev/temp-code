import { MspError } from '@muse-code/sdk'
import type {
  ApprovalRequestParams,
  ApprovalUpdatedParams,
  Item,
  ItemDeltaParams,
  Notification,
  Request,
  SessionContextUsageParams,
  SessionResumeResult,
  SessionStartResult,
  SubscriptionUsage,
  TurnCompletedParams,
  TurnModelRetryScheduledParams,
  TurnStartResult,
  UserInputRequestParams
} from '@muse-code/sdk/dist/src/msp'
import type { Attachment } from '@shared/events'
import { bridgeMcpConfig } from '../apptools'
import { museConfigDirFor, museDirKind, museSkillsFor, recaptureMuseDir } from '../museConfigDirs'
import { exitWords, spawnMuseHost, type MuseHost } from './harness/museHost'
import {
  answersOf,
  approvalChoice,
  approvalTitle,
  foldDelta,
  foldItem,
  questionsOf,
  reasoningEffortOf,
  retryWords,
  serveArgs,
  sessionResumeParams,
  sessionStartParams,
  turnError,
  turnInput,
  type SessionFacts
} from './harness/museProtocol'
import { createTranslator } from './harness/toAgentEvent'
import { FIRST_OUTPUT_SILENCE } from './silence'
import type { DriverCtx, DriverHandle, HarnessDriver, SendOpts } from './types'

/**
 * HarnessDriver for Meta's Muse Code: one `muse serve` per thread over the
 * Muse Session Protocol (harness/museHost.ts spawns it through the SDK and
 * keeps the raw connection; harness/museProtocol.ts is the pure mapping).
 *
 *   start      spawn + initialize; `session/resume` by the thread's native
 *              id (not found → the registry forgets it and this starts
 *              fresh), else `session/start` with the thread's permission
 *              profile and the app-tools bridge as a session MCP server.
 *   send       `turn/start` (effort on every turn, `ifBusy: queue`); a
 *              steer mid-turn is `turn/steer` on the live turn, received
 *              when its `userMessage` item lands (its commandId is ours).
 *   interrupt  `turn/cancel`; compact `session/compact`; stopTask `task/stop`.
 *   approvals  `approval/requested` → ctx.requestApproval → `approval/decide`
 *              with the request's own approved/denied choice; a stage
 *              advance (`approval/updated`) re-sends the decision.
 *   questions  `userInput/requested` → question-request; `userInput/answer`.
 *   usage      `usage/changed` → ctx.observeUsage (the 5h and weekly
 *              windows), a quota stop → ctx.observeLimit until it lifts.
 *
 * PERMISSION → the CLI's profile: safe and edits ride `:ask-me` (safe asks
 * for everything the policy leaves open, edits only for what the profile
 * marks restricted), auto is `:unrestricted` (no sandbox, no prompts).
 */
export const museDriver: HarnessDriver = { id: 'muse', start }

/** A message pushed this long ago with nothing back: the row errors and the registry re-queues it once. */
export const FIRST_OUTPUT_MS = 60_000

/** TEMP_CODE_MUSE_TRACE=1 logs one line per frame each way. */
const TRACE = process.env.TEMP_CODE_MUSE_TRACE === '1'

async function start(ctx: DriverCtx): Promise<DriverHandle> {
  const { session, emit } = ctx
  const translator = createTranslator(ctx)
  // One config dir per (account, skills scope), its skills the store's (museConfigDirs.ts).
  const skills = museSkillsFor(session)
  const configDir = museConfigDirFor(ctx.route?.account ?? null, skills?.scope, skills?.pointer ?? null)
  const facts: SessionFacts = { cwd: session.cwd, model: session.model, permission: session.permission, bridge: bridgeMcpConfig(session.id, { computerImages: 'parts' }) }

  let disposed = false
  let host: MuseHost | null = null
  let nativeId: string | null = null
  let turnOpen = false
  let currentTurnId: string | null = null
  let firstFrame = false
  let watchdog: NodeJS.Timeout | null = null
  const itemKinds = new Map<string, Item['kind']>()
  const toolOutput = new Map<string, string>()
  const steers = new Map<string, string>()
  const approvals = new Map<string, { request: ApprovalRequestParams; allow?: boolean; decided: Set<string> }>()
  const questions = new Map<string, { request: UserInputRequestParams; requestId: string }>()
  let questionSeq = 0

  const stderrLines: string[] = []
  const onStderr = (chunk: string): void => {
    for (const line of chunk.split('\n')) if (line.trim()) stderrLines.push(line.trim())
    if (stderrLines.length > 20) stderrLines.splice(0, stderrLines.length - 20)
  }

  const clearWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }
  const armWatchdog = (): void => {
    clearWatchdog()
    firstFrame = false
    watchdog = setTimeout(() => {
      if (disposed || firstFrame || !turnOpen) return
      emit({ type: 'error', message: FIRST_OUTPUT_SILENCE })
      settle()
      void host?.close()
    }, FIRST_OUTPUT_MS)
  }
  const sawFrame = (): void => {
    if (firstFrame) return
    firstFrame = true
    ctx.mark?.('first-message')
    clearWatchdog()
  }

  const settle = (): void => {
    if (!turnOpen) return
    turnOpen = false
    currentTurnId = null
    clearWatchdog()
    emit({ type: 'phase', phase: null })
    translator.settleTurn()
  }

  const onExit = (): void => {
    if (disposed) return
    const words = host ? exitWords(hostExit ?? { kind: 'crash', exitCode: null, exitSignal: null, stderrTail: stderrLines }) : null
    if (turnOpen) {
      emit({ type: 'error', message: words ?? 'muse serve exited unexpectedly mid-turn' })
      settle()
      return
    }
    if (words) console.log(`[muse] ${session.id}: ${words}`)
    ctx.harnessGone?.()
  }
  let hostExit: Parameters<typeof exitWords>[0] | null = null

  const spawn = async (args: string[]): Promise<MuseHost> =>
    spawnMuseHost({
      sessionId: session.id,
      cwd: session.cwd,
      configDir,
      credentialFile: museDirKind(configDir) === 'account',
      args,
      onStderr,
      onExit: (exit) => {
        hostExit = exit
        onExit()
      }
    })

  // ── boot ────────────────────────────────────────────────────────
  emit({ type: 'phase', phase: 'cli-starting' })
  ctx.mark?.('handle', 'cold')
  host = await spawn([])
  // No usable sandbox on this host (a Linux box without a bubblewrap the
  // binary can run): every shell call would be refused, so the host runs
  // without one; the thread's worktree and the process guard are the fence.
  const extraArgs = serveArgs(process.platform, host.init)
  if (extraArgs.length) {
    console.log(`[muse] ${session.id}: sandbox unavailable (${host.init.sandboxUnavailableReason ?? 'unknown'}); restarting with ${extraArgs.join(' ')}`)
    await host.close()
    host = await spawn(extraArgs)
  }
  ctx.mark?.('init')
  emit({ type: 'phase', phase: 'initializing' })
  const conn = host.connection

  const command = (method: string, params: Record<string, unknown>, commandId?: string): Promise<Record<string, unknown>> => {
    if (TRACE) console.log(`[muse] ${session.id} → ${method} ${JSON.stringify(params).slice(0, 160)}`)
    return conn.command(method, params, commandId ? { commandId } : undefined)
  }

  // ── notifications and server requests ───────────────────────────
  const onItem = (phase: 'started' | 'updated' | 'completed', item: Item): void => {
    itemKinds.set(item.itemId, item.kind)
    if (item.kind === 'userMessage' && item.commandId && steers.has(item.commandId)) {
      emit({ type: 'steer', steerId: steers.get(item.commandId)!, state: 'received', how: 'in-turn' })
      steers.delete(item.commandId)
    }
    if (item.kind === 'compaction') {
      if (phase === 'started') emit({ type: 'compaction', phase: 'start', trigger: item.trigger === 'manual' ? 'manual' : 'auto' })
      else if (phase === 'completed') {
        emit({
          type: 'compaction',
          phase: item.outcome === 'failed' ? 'failed' : 'done',
          ...(typeof item.tokensBefore === 'number' ? { preTokens: item.tokensBefore } : {}),
          ...(typeof item.tokensAfter === 'number' ? { postTokens: item.tokensAfter } : {}),
          ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {})
        })
      }
      return
    }
    const events = foldItem(phase, item, toolOutput.get(item.itemId) ?? '')
    for (const ev of events) {
      if (ev.type === 'tool.started' || ev.type === 'message.delta') ctx.mark?.('first-content')
      translator.push(ev)
    }
    if (phase === 'completed') toolOutput.delete(item.itemId)
  }

  const onDelta = (params: ItemDeltaParams): void => {
    const kind = itemKinds.get(params.itemId)
    const ev = foldDelta(kind, params)
    if (ev) {
      ctx.mark?.('first-content')
      emit({ type: 'phase', phase: null })
      translator.push(ev)
      return
    }
    if (params.field === 'output' || params.field === undefined) {
      toolOutput.set(params.itemId, (toolOutput.get(params.itemId) ?? '') + params.delta)
    }
  }

  const decide = async (approvalId: string, allow: boolean): Promise<void> => {
    const rec = approvals.get(approvalId)
    if (!rec) return
    rec.allow = allow
    const requirement = rec.request.currentRequirementId
    const key = `${requirement.approvalId}:${requirement.sourceIndex}`
    if (rec.decided.has(key)) return
    rec.decided.add(key)
    const choice = approvalChoice(rec.request, allow)
    if (!choice) {
      console.log(`[muse] ${session.id}: approval ${approvalId} offers no ${allow ? 'approved' : 'denied'} choice; left to the host`)
      return
    }
    try {
      // The deny/abort choice wire carries no text, so a denial reason cannot be sent.
      await command('approval/decide', { sessionId: nativeId, approvalId, choiceId: choice.choiceId, requirementId: requirement })
    } catch (err) {
      if (!(err instanceof MspError && (err.kind === 'approvalAlreadyResolved' || err.kind === 'approvalNotFound'))) {
        emit({ type: 'error', message: `approval could not be decided: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
  }

  const onApprovalRequested = (params: ApprovalRequestParams): void => {
    if (approvals.has(params.approvalId)) return
    approvals.set(params.approvalId, { request: params, decided: new Set() })
    // The app's own tools (the bridge's `app` server) are instruction-gated
    // and visible already; a card for each would stall every spawn and
    // wait, as codex's driver says. Only they skip the person.
    if (params.toolName.startsWith('mcp__app__')) {
      void decide(params.approvalId, true)
      return
    }
    const callId = params.toolCallId || params.itemId
    void ctx
      .requestApproval({ requestId: params.approvalId, toolName: params.toolName, input: toolInputOf(params), title: approvalTitle(params), callId })
      .then((allow) => decide(params.approvalId, allow))
  }

  const onApprovalUpdated = (params: ApprovalUpdatedParams): void => {
    const rec = approvals.get(params.approvalId)
    if (!rec || rec.allow === undefined) return
    const next = (params as unknown as { currentRequirementId?: ApprovalRequestParams['currentRequirementId'] }).currentRequirementId
    if (!next) return
    rec.request = { ...rec.request, currentRequirementId: next }
    void decide(params.approvalId, rec.allow)
  }

  const onQuestion = (params: UserInputRequestParams): void => {
    if (questions.has(params.userInputId)) return
    const requestId = `muse-${++questionSeq}`
    questions.set(params.userInputId, { request: params, requestId })
    emit({ type: 'question-request', requestId, questions: questionsOf(params), callId: params.toolCallId || params.itemId })
    emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
  }

  const onTurnCompleted = (params: TurnCompletedParams): void => {
    sawFrame()
    const words = turnError(params)
    if (params.error?.quota) ctx.observeLimit?.('5h', params.error.quota.resetsAtMs)
    if (words) emit({ type: 'error', message: words, ...(params.error?.quota ? { limit: { window: '5h' as const } } : {}) })
    // The turn's tokens ride a usage snapshot; the translator's settle
    // writes the one turn-complete row.
    if (params.usage) emit({ type: 'usage', inputTokens: params.usage.inputTokens, outputTokens: params.usage.outputTokens })
    settle()
  }

  const onUsage = (usage: SubscriptionUsage): void => {
    ctx.observeUsage?.([
      { label: '5h', usedPercent: usage.window.usedPercent, resetsAt: usage.window.resetsAtMs, periodMs: usage.window.windowDurationMins * 60_000 },
      { label: 'Weekly', usedPercent: usage.weekly.usedPercent, resetsAt: usage.weekly.resetsAtMs, periodMs: 7 * 24 * 3_600_000 }
    ])
  }

  conn.onProtocolError((err) => console.log(`[muse] ${session.id}: protocol error: ${err.message}`))
  conn.onNotification((n: Notification) => {
    if (disposed) return
    if (TRACE) console.log(`[muse] ${session.id} ← ${n.method} ${JSON.stringify(n.params ?? {}).slice(0, 160)}`)
    try {
      onNotification(n)
    } catch (err) {
      console.log(`[muse] ${session.id}: ${n.method} handler failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    }
  })
  const onNotification = (n: Notification): void => {
    const params = (n.params ?? {}) as Record<string, unknown>
    const sid = params.sessionId
    if (n.method === 'usage/changed') return onUsage(n.params as unknown as SubscriptionUsage)
    if (typeof sid === 'string' && nativeId && sid !== nativeId) return
    switch (n.method) {
      case 'turn/started':
        // The host's own ack that a turn began, not the model's first word:
        // the first-output watchdog stays armed until an item, a retry
        // notice, an approval or a question lands (a host that opens a turn
        // and then says nothing is the silence it exists for).
        currentTurnId = String(params.turnId)
        return
      case 'item/started':
        sawFrame()
        return onItem('started', params.item as Item)
      case 'item/updated':
        return onItem('updated', params.item as Item)
      case 'item/completed':
        return onItem('completed', params.item as Item)
      case 'item/delta':
        sawFrame()
        return onDelta(n.params as unknown as ItemDeltaParams)
      case 'turn/completed':
        return onTurnCompleted(n.params as unknown as TurnCompletedParams)
      case 'turn/modelRetryScheduled': {
        const p = n.params as unknown as TurnModelRetryScheduledParams
        sawFrame()
        emit({ type: 'phase', phase: 'retrying', detail: retryWords(p.attempt, p.maxAttempts, p.retryDelayMs, p.httpStatus), retry: { attempt: p.attempt, delayMs: p.retryDelayMs, reason: p.httpStatus ? `HTTP ${p.httpStatus}` : p.errorKind } })
        return
      }
      case 'session/contextUsage': {
        const p = n.params as unknown as SessionContextUsageParams
        if (p.usedTokens > 0) emit({ type: 'context', tokens: p.usedTokens, ...(p.windowTokens ? { window: p.windowTokens } : {}) })
        return
      }
      case 'approval/requested':
        sawFrame()
        return onApprovalRequested(n.params as unknown as ApprovalRequestParams)
      case 'approval/updated':
        return onApprovalUpdated(n.params as unknown as ApprovalUpdatedParams)
      case 'approval/resolved':
        approvals.delete(String(params.approvalId))
        return
      case 'userInput/requested':
        sawFrame()
        return onQuestion(n.params as unknown as UserInputRequestParams)
      case 'userInput/settled':
        questions.delete(String(params.userInputId))
        return
      default:
        return
    }
  }
  conn.onServerRequest(async (req: Request) => {
    if (req.method === 'approval/request') onApprovalRequested(req.params as unknown as ApprovalRequestParams)
    else if (req.method === 'userInput/request') onQuestion(req.params as unknown as UserInputRequestParams)
    else throw new MspError({ code: -32601, message: `method not found: ${req.method}`, data: { kind: 'methodNotFound', retryable: false } })
    return {}
  })

  // ── the session ─────────────────────────────────────────────────
  const open = async (): Promise<void> => {
    if (session.nativeId) {
      try {
        const res = (await command('session/resume', sessionResumeParams(session.nativeId, facts) as Record<string, unknown>)) as unknown as SessionResumeResult
        nativeId = res.session.sessionId
        // A question or approval still open from before the restart comes
        // back as a server request right after this answer; the handlers
        // above take it.
        return
      } catch (err) {
        if (err instanceof MspError && err.kind === 'sessionNotFound') {
          console.log(`[muse] ${session.id}: session ${session.nativeId} not found on this host; starting fresh`)
          ctx.nativeSessionLost?.()
        } else if (err instanceof MspError && err.kind === 'sessionInUse') {
          throw new Error('Muse Code session in use by another client')
        } else throw err
      }
    }
    const res = (await command('session/start', sessionStartParams(facts) as Record<string, unknown>)) as unknown as SessionStartResult
    nativeId = res.session.sessionId
    ctx.setNativeId(nativeId)
  }
  try {
    await open()
  } catch (err) {
    await host.close()
    throw err
  }
  emit({ type: 'phase', phase: null })

  return {
    confirmsSteers: true,
    // A host line into the live turn alone (`turn/steer`, no steer id to
    // stamp); no turn or a refusal answers false and the registry holds it.
    async whisper(text: string): Promise<boolean> {
      if (disposed || !host?.alive() || !turnOpen || !currentTurnId) return false
      try {
        await command('turn/steer', { sessionId: nativeId, expectedTurnId: currentTurnId, input: [{ type: 'text', text }] })
        return true
      } catch {
        return false
      }
    },
    async send(text: string, attachments: Attachment[] = [], opts: SendOpts = {}): Promise<void> {
      if (disposed || !host?.alive()) throw new Error('muse serve is gone')
      const input = await turnInput(text, attachments)
      const effort = reasoningEffortOf(session.reasoning)
      if (turnOpen && currentTurnId && opts.steerId) {
        const commandId = conn.mintCommandId()
        steers.set(commandId, opts.steerId)
        try {
          await command('turn/steer', { sessionId: nativeId, expectedTurnId: currentTurnId, input, ...(effort ? { reasoningEffort: effort } : {}) }, commandId)
        } catch (err) {
          steers.delete(commandId)
          throw err
        }
        return
      }
      if (turnOpen) throw new Error('Muse Code is still running a turn')
      turnOpen = true
      translator.beginTurn()
      emit({ type: 'phase', phase: 'waiting-provider' })
      armWatchdog()
      try {
        const ack = (await command('turn/start', { sessionId: nativeId, input, ifBusy: 'queue', ...(effort ? { reasoningEffort: effort } : {}) })) as unknown as TurnStartResult
        currentTurnId = ack.turnId
        ctx.mark?.('delivered')
      } catch (err) {
        settle()
        throw err
      }
    },
    interrupt(): void {
      if (!nativeId) return
      void command('turn/cancel', { sessionId: nativeId, ...(currentTurnId ? { turnId: currentTurnId } : {}) }).catch(() => undefined)
    },
    approve(requestId: string, allow: boolean, _reason?: string): boolean {
      // The registry answered through requestApproval's promise; this is
      // the stale path (a request from a previous process of this harness).
      return approvals.has(requestId) && allow === approvals.get(requestId)?.allow
    },
    answer(requestId: string, answers: string[][] | null): boolean {
      const entry = [...questions.entries()].find(([, q]) => q.requestId === requestId)
      if (!entry) return false
      const [userInputId, q] = entry
      questions.delete(userInputId)
      emit({ type: 'question-resolved', requestId, answers })
      emit({ type: 'status', status: 'running' })
      const call = answers
        ? command('userInput/answer', { sessionId: nativeId, userInputId, answers: answersOf(q.request, answers) })
        : command('userInput/cancel', { sessionId: nativeId, userInputId })
      void call.catch((err) => emit({ type: 'error', message: `the answer could not be delivered: ${err instanceof Error ? err.message : String(err)}` }))
      return true
    },
    async compact(): Promise<void> {
      await command('session/compact', { sessionId: nativeId })
    },
    async stopTask(taskId: string): Promise<void> {
      await command('task/stop', { sessionId: nativeId, taskId })
    },
    alive: () => !!host?.alive(),
    pid: () => host?.pid ?? null,
    async dispose(): Promise<void> {
      disposed = true
      clearWatchdog()
      await host?.close()
      // The CLI rotates the access token in place on some calls: a copy
      // that moved on goes back to the vault.
      recaptureMuseDir(ctx.route?.account ?? null)
    }
  }
}

function toolInputOf(params: ApprovalRequestParams): unknown {
  if (params.subject.command) return { command: params.subject.command }
  try {
    return JSON.parse(params.rawArgs)
  } catch {
    return { args: params.rawArgs }
  }
}
