import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Attachment, PermissionPolicy, SessionStatus } from '@shared/events'
import type { Reasoning } from '@shared/catalog'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { harnessEnv, resolveBinary } from './binaries'
import { expandSlashRefs } from '../slash'
import { toolDisplay } from './display'
import { bridgeMcpConfig } from '../apptools'
import { endpointFor } from '../endpoint'
import { observeCodexSnapshot } from '../gatewayObserve'

/**
 * Codex driver — `codex app-server`, protocol v2 (verified live against
 * codex-cli 0.146.1; see scripts/probe-codex.ts and the CLI's own
 * `generate-json-schema`):
 *
 *   initialize {clientInfo} → thread/start|thread/resume → turn/start
 *   {threadId, input:[{type:'text',text}], effort}
 *
 * Streaming arrives as notifications:
 *   item/started + item/completed (item.type: agentMessage | reasoning |
 *   commandExecution | fileChange | mcpToolCall | webSearch | ...),
 *   item/agentMessage/delta, item/reasoning/textDelta|summaryTextDelta,
 *   thread/tokenUsage/updated, turn/started, turn/completed.
 *
 * Approvals come as server→client JSON-RPC REQUESTS
 * (item/commandExecution/requestApproval, item/fileChange/requestApproval)
 * answered with {decision: 'accept'|'decline'}.
 */

const APPROVAL_POLICY: Record<PermissionPolicy, string> = {
  safe: 'untrusted',
  edits: 'on-request',
  auto: 'never'
}

// The sandbox is where codex's real capabilities live: workspace-write
// alone blocks ALL network, which silently kills MCP servers, plugins
// (Linear), and web access however the user's own codex is configured.
const SANDBOX: Record<PermissionPolicy, string> = {
  safe: 'read-only',
  edits: 'workspace-write',
  auto: 'danger-full-access'
}

// Our reasoning enum matches codex's effort ladder 1:1 (model/list,
// codex-cli 0.147.0) — sol/terra go all the way to ultra.
const EFFORT: Record<Reasoning, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra'
}

interface RpcFrame {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

class AppServerConn {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  constructor(
    binPath: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    private onNotify: (method: string, params: Record<string, unknown>) => void,
    private onRequest: (
      id: number | string,
      method: string,
      params: Record<string, unknown>
    ) => void,
    onExit: (code: number | null) => void
  ) {
    this.proc = spawn(binPath, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg: RpcFrame
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id !== undefined && msg.method) {
        // server→client request (approvals)
        this.onRequest(msg.id, msg.method, msg.params ?? {})
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? 'app-server error'))
          else p.resolve(msg.result)
        }
      } else if (msg.method) {
        this.onNotify(msg.method, msg.params ?? {})
      }
    })
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values())
        p.reject(new Error(`codex app-server exited (${code})`))
      this.pending.clear()
      onExit(code)
    })
    this.proc.on('error', () => onExit(-1))
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  respond(id: number | string, result: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  kill(): void {
    this.proc.kill()
  }
}

type Item = Record<string, unknown> & { type?: string; id?: string }

/** The humanized face of an addon call — exactly what the Codex app
 *  shows: appContext's appName + actionName when the plugin provides
 *  them, else the plugin/server name and a de-snaked tool name. */
function mcpDisplay(item: Item): { app?: string; action?: string } {
  const ctx = (item.appContext ?? {}) as { appName?: string | null; actionName?: string | null }
  const plugin = typeof item.pluginId === 'string' ? item.pluginId.split('@')[0] : undefined
  const tool = String(item.tool ?? '')
  // codex_apps tools arrive as "linear.save_document" — first segment is
  // the app, the rest is the action.
  const dotted = tool.includes('.') ? tool.split('.') : null
  const app = ctx.appName ?? plugin ?? dotted?.[0] ?? String(item.server ?? '')
  const rawAction = ctx.actionName ?? (dotted ? dotted.slice(1).join('.') : tool)
  const action = rawAction.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  return { app: app || undefined, action: action || undefined }
}

/** Bridged app tools keep their MCP "server.tool" name except the task
 *  list: the bridge's update_plan stands in for the native tool Codex no
 *  longer has, and the todo model matches it by bare name. */
function mcpName(item: Item): string {
  if (item.server === 'app' && item.tool === 'update_plan') return 'update_plan'
  return `${item.server}.${item.tool}`
}

/** A connector tool result saying "reauthenticate" carries the ids that
 *  name its fix: chatgpt.com/apps/<slug>/<connector_id>, the same page
 *  the Codex app opens. */
function connectorReauth(item: Item): { app: string; url: string } | undefined {
  const result = item.result as
    | { _meta?: { _codex_apps?: { connector_auth_failure?: Record<string, unknown> } } }
    | null
    | undefined
  const fail = result?._meta?._codex_apps?.connector_auth_failure
  if (!fail || fail.is_auth_failure !== true) return undefined
  const app = mcpDisplay(item).app ?? String(fail.connector_name ?? 'connector')
  const url =
    typeof fail.install_url === 'string'
      ? fail.install_url
      : `https://chatgpt.com/apps/${app.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${String(fail.connector_id ?? '')}`
  return fail.connector_id || typeof fail.install_url === 'string' ? { app, url } : undefined
}

export const codexDriver: HarnessDriver = {
  id: 'codex',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx

    const binPath = await resolveBinary('codex')
    if (!binPath) throw new Error('codex CLI not found — install it and log in (`codex login`)')
    const env = await harnessEnv()

    let currentTurnId: string | null = null
    // MCP servers (plugins included) take seconds to mount their tools;
    // a turn that starts first snapshots an empty registry. The first
    // send waits for startup to settle (bounded), so /linear-style
    // plugins are callable from message one.
    const mcpStarting = new Set<string>()
    let mcpSettled: (() => void) | null = null
    let firstTurnGate: Promise<void> | null = new Promise((resolve) => {
      const bail = setTimeout(() => resolve(), 20_000)
      mcpSettled = () => {
        clearTimeout(bail)
        resolve()
      }
    })
    let planUpdateSeq = 0
    // Mirrors the harness's current goal (thread goals, probed live on
    // codex-cli 0.147.0 — scripts/probe-goal-codex.ts) so notifications can
    // be classified set-vs-updated and no-change updates dropped. Seeded
    // from the folded log: codex re-announces the goal on thread resume,
    // and an unseeded mirror would log that echo as a fresh set.
    let lastGoal: { condition: string; status: string } | null = session.goal
      ? { condition: session.goal.condition, status: 'active' }
      : null
    let lastUsageEmit = 0
    let lastUsage: { inputTokens?: number; outputTokens?: number } = {}
    let contextTokens = 0
    let contextWindow = 0
    let disposed = false
    const setStatus = (status: SessionStatus): void => emit({ type: 'status', status })

    const itemStarted = (item: Item): void => {
      switch (item.type) {
        // GPT reasoning often has no visible summary; announcing the item
        // with an empty streaming delta shows a live "Thinking" shimmer that
        // the renderer drops once the item completes still empty.
        case 'reasoning':
          emit({ type: 'thinking', text: '', delta: true, msgId: String(item.id), blockIndex: 0 })
          break
        case 'commandExecution':
          emit({
            type: 'tool-call',
            callId: String(item.id),
            name: 'shell',
            input: { command: item.command, cwd: item.cwd },
            display: toolDisplay('Bash', { command: item.command })
          })
          break
        case 'fileChange':
          emit({
            type: 'tool-call',
            callId: String(item.id),
            name: 'apply_patch',
            input: item.changes
          })
          break
        case 'mcpToolCall':
          emit({
            type: 'tool-call',
            callId: String(item.id),
            name: mcpName(item),
            input: item.arguments,
            display: item.tool === 'update_plan' ? undefined : mcpDisplay(item)
          })
          break
        case 'webSearch':
          emit({
            type: 'tool-call',
            callId: String(item.id),
            name: 'web_search',
            input: { query: item.query }
          })
          break
      }
    }

    const itemCompleted = (item: Item): void => {
      switch (item.type) {
        case 'agentMessage':
          emit({
            type: 'assistant-text',
            text: String(item.text ?? ''),
            delta: false,
            msgId: String(item.id),
            blockIndex: 0
          })
          break
        case 'reasoning': {
          // Always emit the final — an empty one settles the streaming block
          // started above so the renderer can retire it.
          const text =
            typeof item.text === 'string'
              ? item.text
              : Array.isArray(item.summary)
                ? item.summary.join('\n')
                : ''
          emit({ type: 'thinking', text, delta: false, msgId: String(item.id), blockIndex: 0 })
          break
        }
        case 'commandExecution':
          emit({
            type: 'tool-result',
            callId: String(item.id),
            output: String(item.aggregatedOutput ?? ''),
            isError: item.exitCode !== 0 && item.exitCode !== null && item.exitCode !== undefined
          })
          break
        case 'fileChange':
          emit({
            type: 'tool-result',
            callId: String(item.id),
            output: JSON.stringify(item.changes ?? item.status, null, 2),
            isError: item.status === 'failed'
          })
          break
        case 'mcpToolCall':
          // The final item carries the settled appContext — refresh the
          // call's face before the result lands (same callId replaces).
          emit({
            type: 'tool-call',
            callId: String(item.id),
            name: mcpName(item),
            input: item.arguments,
            display: item.tool === 'update_plan' ? undefined : mcpDisplay(item)
          })
          emit({
            type: 'tool-result',
            callId: String(item.id),
            reauth: connectorReauth(item),
            output: JSON.stringify(item.result ?? null, null, 2),
            isError: item.status === 'failed'
          })
          break
        case 'webSearch':
          emit({
            type: 'tool-result',
            callId: String(item.id),
            output: JSON.stringify(item.results ?? [], null, 2),
            isError: false
          })
          break
      }
    }

    const goalUpdated = (params: Record<string, unknown>): void => {
      const goal = params.goal as { objective?: string; status?: string } | undefined
      if (!goal || typeof goal.objective !== 'string') return
      const status = String(goal.status ?? 'active')
      // turnId is non-null exactly when the model set/updated the goal
      // itself (its create_goal/update_goal tools, mid-turn).
      const byModel = params.turnId != null || undefined
      if (status === 'complete') {
        // Met transitions a live goal; 'complete' with none known is the
        // resume echo of a goal that already ended — the log has its met.
        if (!lastGoal) return
        emit({ type: 'goal', phase: 'met', condition: goal.objective, byModel })
        lastGoal = null
        return
      }
      // ThreadGoal also carries usage counters and pacing states (paused,
      // blocked, …); only an objective change is a row. The mirror still
      // tracks status so 'complete' above stays a real transition.
      const changed = goal.objective !== lastGoal?.condition
      if (changed)
        emit({ type: 'goal', phase: lastGoal ? 'updated' : 'set', condition: goal.objective, byModel })
      lastGoal = { condition: goal.objective, status }
    }

    const onNotify = (method: string, params: Record<string, unknown>): void => {
      switch (method) {
        case 'thread/goal/updated':
          goalUpdated(params)
          break
        case 'thread/goal/cleared':
          if (lastGoal) emit({ type: 'goal', phase: 'cleared', condition: lastGoal.condition })
          lastGoal = null
          break
        case 'mcpServer/startupStatus/updated': {
          const name = String(params.name ?? '')
          if (params.status === 'starting') mcpStarting.add(name)
          else mcpStarting.delete(name)
          // Every server reached a terminal state — release the gate.
          if (mcpStarting.size === 0 && mcpSettled) {
            const release = mcpSettled
            mcpSettled = null
            // Grace beat: statuses arrive one by one at boot; releasing on
            // the first terminal event would race servers not yet announced.
            setTimeout(release, 500)
          }
          break
        }
        case 'turn/started':
          currentTurnId = String((params.turn as Item)?.id ?? '')
          break
        case 'item/started':
          itemStarted((params.item ?? {}) as Item)
          break
        case 'item/completed':
          itemCompleted((params.item ?? {}) as Item)
          break
        case 'item/agentMessage/delta':
          emit({
            type: 'assistant-text',
            text: String(params.delta ?? ''),
            delta: true,
            msgId: String(params.itemId),
            blockIndex: 0
          })
          break
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
          emit({
            type: 'thinking',
            text: String(params.delta ?? ''),
            delta: true,
            msgId: String(params.itemId),
            blockIndex: 0
          })
          break
        case 'item/fileChange/patchUpdated': {
          // A growing patch streams per update (M23) — ride the existing
          // partial tool-call path so cards render files as they appear.
          const item = (params.item ?? params) as Item
          if (item?.id !== undefined) {
            emit({
              type: 'tool-call',
              callId: String(item.id),
              name: 'apply_patch',
              input: item.changes ?? (params.changes as unknown),
              partial: true
            })
          }
          break
        }
        case 'turn/plan/updated': {
          // Codex's native task list (update_plan) arrives as its own
          // notification, not an item — surface it as an update_plan
          // tool call so the todo model and the implementation board see
          // it. Statuses normalize (inProgress → in_progress).
          const plan = (params.plan as { step?: string; status?: string }[] | undefined) ?? []
          const callId = `plan-${String(params.turnId ?? 'turn')}-${planUpdateSeq++}`
          emit({
            type: 'tool-call',
            callId,
            name: 'update_plan',
            input: {
              plan: plan.map((p) => ({
                step: p.step,
                status: p.status === 'inProgress' ? 'in_progress' : p.status
              }))
            }
          })
          emit({ type: 'tool-result', callId, output: 'task list updated', isError: false })
          break
        }
        case 'thread/tokenUsage/updated': {
          const tu = params.tokenUsage as
            | {
                total?: Record<string, number>
                last?: Record<string, number>
                modelContextWindow?: number
              }
            | undefined
          if (tu?.total)
            lastUsage = { inputTokens: tu.total.inputTokens, outputTokens: tu.total.outputTokens }
          // The last turn's total ≈ what the context currently holds.
          if (tu?.last?.totalTokens !== undefined && tu.last.totalTokens !== contextTokens) {
            contextTokens = tu.last.totalTokens
            if (tu?.modelContextWindow) contextWindow = tu.modelContextWindow
            // Live meter: forwarded as it moves so every thread's ring is
            // current mid-turn, not just after a settle.
            if (contextTokens > 0)
              emit({
                type: 'context',
                tokens: contextTokens,
                ...(contextWindow ? { window: contextWindow } : {})
              })
          } else if (tu?.modelContextWindow) contextWindow = tu.modelContextWindow
          // Cumulative snapshots for per-task token deltas (M25) —
          // throttled so the log doesn't grow with every chunk.
          if (tu?.total && Date.now() - lastUsageEmit > 5_000) {
            lastUsageEmit = Date.now()
            emit({
              type: 'usage',
              inputTokens: tu.total.inputTokens,
              outputTokens: tu.total.outputTokens
            })
          }
          break
        }
        case 'turn/completed': {
          currentTurnId = null
          const turn = params.turn as { status?: string; error?: { message?: string } | null }
          if (turn?.error?.message) emit({ type: 'error', message: turn.error.message })
          emit({ type: 'turn-complete', ...lastUsage })
          setStatus('idle')
          break
        }
        case 'error':
          emit({ type: 'error', message: String(params.message ?? 'codex error') })
          break
        case 'account/rateLimits/updated':
          observeCodexSnapshot(params)
          break
      }
    }

    const pendingApprovals = new Map<string, (allow: boolean) => void>()
    const pendingQuestions = new Map<string, (answers: string[][] | null) => void>()

    const onRequest = (
      id: number | string,
      method: string,
      params: Record<string, unknown>
    ): void => {
      // The model stopped to ask questions (shape probed from codex-cli
      // 0.147: ToolRequestUserInputQuestion {id?, header, question, isOther,
      // options[{label, description}]}, answered per question with
      // {answers: string[]}).
      if (method === 'item/tool/requestUserInput') {
        const raw = Array.isArray(params.questions)
          ? (params.questions as Record<string, unknown>[])
          : []
        const questions = raw.flatMap((q) => {
          const text = typeof q.question === 'string' ? q.question : ''
          if (!text) return []
          return [
            {
              question: text,
              header: typeof q.header === 'string' ? q.header : undefined,
              multiSelect: q.multiSelect === true,
              allowFreeform: q.isOther !== false,
              options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [])
                .filter((o) => typeof o.label === 'string')
                .map((o) => ({
                  label: o.label as string,
                  description: typeof o.description === 'string' ? o.description : undefined
                }))
            }
          ]
        })
        const requestId = `codex-${id}`
        emit({
          type: 'question-request',
          requestId,
          questions,
          callId: params.itemId ? String(params.itemId) : undefined
        })
        emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
        pendingQuestions.set(requestId, (answers) => {
          pendingQuestions.delete(requestId)
          emit({ type: 'question-resolved', requestId, answers })
          emit({ type: 'status', status: 'running' })
          conn.respond(id, {
            answers: Object.fromEntries(
              raw.map((q, i) => [String(q.id ?? i), { answers: answers?.[i] ?? [] }])
            )
          })
        })
        return
      }
      // MCP-server trust prompt (fires on first tool use per server; params
      // carry only serverName/threadId). Our own app bridge is pre-trusted —
      // it IS the app's toolset, and its one write (app_start_thread) is
      // instruction-gated, visible, and permission-inherited. Other servers
      // follow the session policy: auto accepts, safe/edits ask the user.
      if (method === 'mcpServer/elicitation/request') {
        const serverName = String(params.serverName ?? '')
        if (serverName === 'app' || session.permission === 'auto') {
          conn.respond(id, { action: 'accept' })
          return
        }
        const requestId = `codex-${id}`
        emit({
          type: 'approval-request',
          requestId,
          toolName: `MCP server "${serverName}"`,
          input: params
        })
        emit({ type: 'status', status: 'waiting' })
        pendingApprovals.set(requestId, (allow) => {
          pendingApprovals.delete(requestId)
          emit({ type: 'approval-resolved', requestId, allow })
          emit({ type: 'status', status: 'running' })
          conn.respond(id, { action: allow ? 'accept' : 'decline' })
        })
        return
      }
      const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
      const isApproval = legacy || method.endsWith('/requestApproval')
      if (!isApproval) {
        // Fail-closed on anything we don't understand — visibly, so an
        // unknown request never masquerades as a user decision.
        emit({ type: 'error', message: `declined unhandled harness request: ${method}` })
        conn.respond(id, { decision: 'decline' })
        return
      }
      const requestId = `codex-${id}`
      const toolName = method.includes('ommandExec')
        ? 'shell'
        : method.includes('ileChange') || method === 'applyPatchApproval'
          ? 'apply_patch'
          : method
      emit({
        type: 'approval-request',
        requestId,
        toolName,
        input: params,
        callId: params.itemId ? String(params.itemId) : undefined
      })
      emit({ type: 'status', status: 'waiting' })
      pendingApprovals.set(requestId, (allow) => {
        pendingApprovals.delete(requestId)
        emit({ type: 'approval-resolved', requestId, allow })
        emit({ type: 'status', status: 'running' })
        conn.respond(id, {
          decision: legacy ? (allow ? 'approved' : 'denied') : allow ? 'accept' : 'decline'
        })
      })
    }

    const conn = new AppServerConn(binPath, env, session.cwd, onNotify, onRequest, (code) => {
      if (disposed) return
      emit({ type: 'error', message: `codex app-server exited unexpectedly (${code})` })
      setStatus('error')
    })

    let threadId = session.nativeId
    try {
      await conn.request('initialize', {
        clientInfo: { name: 'temp-code', title: 'temp-code', version: '0.1.0' }
      })
      // App tools (docs/PLAN-2.md M10): the stdio bridge forwards
      // app_list_threads / app_read_thread / app_start_thread back to the
      // app's WS server, so codex threads can operate the app like claude.
      const bridgeEntry = bridgeMcpConfig(session.id)
      // Provider traffic goes through Aliax's shim or our own gateway, which
      // swap in the pinned account's token.
      const endpoint = await endpointFor('codex')
      const threadParams = {
        cwd: session.cwd,
        model: session.model,
        approvalPolicy: APPROVAL_POLICY[session.permission],
        sandbox: SANDBOX[session.permission],
        config: {
          // The structured-question tool (request_user_input) is
          // feature-gated off by default — without it the model dumps
          // "reply 1A/2B" menus as plain text instead of asking in the UI.
          features: {
            default_mode_request_user_input: true,
            // Codex's native multi-agent tools are literally named
            // spawn_agent/wait_agent/list_agents, serve ONLY OpenAI
            // models, and shadow the app's cross-provider spawn toolset
            // by bare name — models call them and conclude "only OpenAI
            // workers exist". Off, so spawn_agent always means the app's.
            multi_agent: false,
            multi_agent_v2: false
          },
          // Fast = OpenAI's priority service tier. Only sent when on, so
          // off keeps whatever the user's own codex config chooses.
          ...(session.fast ? { service_tier: 'priority' } : {}),
          ...(bridgeEntry ? { mcp_servers: { app: bridgeEntry } } : {}),
          ...(endpoint ? { chatgpt_base_url: endpoint } : {})
        }
      }
      const startFresh = async (): Promise<void> => {
        const res = (await conn.request('thread/start', threadParams)) as {
          thread?: { id?: string }
        }
        if (res.thread?.id) {
          threadId = res.thread.id
          ctx.setNativeId(threadId)
        }
      }
      if (threadId) {
        try {
          await conn.request('thread/resume', { threadId, ...threadParams })
        } catch (err) {
          // A thread that never ran a turn has no rollout file on disk, so
          // it can't be resumed by a new app-server process. Nothing is
          // lost — start fresh.
          if (String(err).includes('no rollout')) await startFresh()
          else throw err
        }
      } else {
        await startFresh()
      }
      // The first usage numbers for the footer; updates arrive as notifications.
      conn.request('account/rateLimits/read', {}).then(observeCodexSnapshot, () => {})
    } catch (err) {
      disposed = true // expected exit, don't also report it as a crash
      conn.kill()
      throw new Error(
        `codex app-server handshake failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Rehydrate the persisted goal (goals live in ~/.codex/goals_1.sqlite
    // and survive resume). Emit only when the log disagrees — a resume of
    // an unchanged goal must not add a duplicate row.
    try {
      const res = (await conn.request('thread/goal/get', { threadId })) as {
        goal?: { objective?: string; status?: string } | null
      }
      const g = res?.goal
      if (g && typeof g.objective === 'string' && g.status !== 'complete') {
        if (session.goal?.condition !== g.objective)
          emit({
            type: 'goal',
            phase: session.goal ? 'updated' : 'set',
            condition: g.objective
          })
        lastGoal = { condition: g.objective, status: String(g.status ?? 'active') }
      } else if (session.goal) {
        emit({ type: 'goal', phase: 'cleared', condition: session.goal.condition })
        lastGoal = null
      }
    } catch {
      // goal RPCs need ChatGPT auth; without it the thread still works
    }

    return {
      async send(text: string, attachments: Attachment[] = []): Promise<void> {
        setStatus('running')
        if (firstTurnGate) {
          await firstTurnGate
          firstTurnGate = null
        }
        // Images are native input items (localImage); other files ride as
        // path references in the text.
        const refs = attachments.filter((a) => a.kind !== 'image').map((a) => a.path)
        const expanded = await expandSlashRefs('codex', session.cwd, text)
        const full = refs.length
          ? `${expanded}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}`
          : expanded
        const input: Record<string, unknown>[] = [{ type: 'text', text: full }]
        for (const a of attachments) {
          if (a.kind === 'image') input.push({ type: 'localImage', path: a.path })
        }
        conn
          .request('turn/start', {
            threadId,
            input,
            effort: EFFORT[session.reasoning]
          })
          .catch((err) => {
            emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
            setStatus('idle')
          })
      },
      interrupt(): void {
        if (currentTurnId) {
          // A dead app-server rejects instantly — stop still settles the
          // session instead of silently doing nothing.
          void conn
            .request('turn/interrupt', { threadId, turnId: currentTurnId })
            .catch(() => setStatus('idle'))
        } else {
          // No turn in flight to interrupt — the status is stale (a crashed
          // turn, a lost turn/completed). Stop still settles the session.
          setStatus('idle')
        }
      },
      approve(requestId: string, allow: boolean): boolean {
        const finish = pendingApprovals.get(requestId)
        finish?.(allow)
        return !!finish
      },
      answer(requestId: string, answers: string[][] | null): boolean {
        const finish = pendingQuestions.get(requestId)
        finish?.(answers)
        return !!finish
      },
      async setGoal(condition: string): Promise<void> {
        // Codex reuses a completed goal's row on set and keeps its
        // 'complete' status — the new goal would be born dead. Clear the
        // stale row first; with no live goal the cleared notification is
        // dropped by its lastGoal guard.
        if (!lastGoal) await conn.request('thread/goal/clear', { threadId }).catch(() => {})
        // Confirmation arrives as a thread/goal/updated notification.
        await conn.request('thread/goal/set', { threadId, objective: condition })
      },
      async clearGoal(): Promise<void> {
        await conn.request('thread/goal/clear', { threadId })
      },
      async contextUsage(): Promise<unknown> {
        if (!contextTokens) return null
        return {
          categories: [{ name: 'Conversation', tokens: contextTokens, color: '#7c86ff' }],
          totalTokens: contextTokens,
          maxTokens: contextWindow,
          percentage: contextWindow ? (contextTokens / contextWindow) * 100 : 0,
          model: session.model
        }
      },
      async dispose(): Promise<void> {
        disposed = true
        conn.kill()
      }
    }
  }
}
