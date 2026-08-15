import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Attachment, PermissionPolicy, SessionStatus } from '@shared/events'
import type { Reasoning } from '@shared/catalog'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { harnessEnv, resolveBinary } from './binaries'
import { expandSlashRefs } from '../slash'

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

export const codexDriver: HarnessDriver = {
  id: 'codex',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx

    const binPath = await resolveBinary('codex')
    if (!binPath) throw new Error('codex CLI not found — install it and log in (`codex login`)')
    const env = await harnessEnv()

    let currentTurnId: string | null = null
    let lastUsage: { inputTokens?: number; outputTokens?: number } = {}
    let disposed = false
    const setStatus = (status: SessionStatus): void => emit({ type: 'status', status })

    const itemStarted = (item: Item): void => {
      switch (item.type) {
        case 'commandExecution':
          emit({
            type: 'tool-call',
            callId: String(item.id),
            name: 'shell',
            input: { command: item.command, cwd: item.cwd }
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
            name: `${item.server}.${item.tool}`,
            input: item.arguments
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
          const text =
            typeof item.text === 'string'
              ? item.text
              : Array.isArray(item.summary)
                ? item.summary.join('\n')
                : undefined
          if (text !== undefined) {
            emit({ type: 'thinking', text, delta: false, msgId: String(item.id), blockIndex: 0 })
          }
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
          emit({
            type: 'tool-result',
            callId: String(item.id),
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

    const onNotify = (method: string, params: Record<string, unknown>): void => {
      switch (method) {
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
        case 'thread/tokenUsage/updated': {
          const total = (params.tokenUsage as { total?: Record<string, number> })?.total
          if (total)
            lastUsage = { inputTokens: total.inputTokens, outputTokens: total.outputTokens }
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
      }
    }

    const pendingApprovals = new Map<string, (allow: boolean) => void>()

    const onRequest = (
      id: number | string,
      method: string,
      params: Record<string, unknown>
    ): void => {
      const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
      const isApproval = legacy || method.endsWith('/requestApproval')
      if (!isApproval) {
        // Fail-closed on anything we don't understand.
        conn.respond(id, { decision: legacy ? 'denied' : 'decline' })
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
      const threadParams = {
        cwd: session.cwd,
        model: session.model,
        approvalPolicy: APPROVAL_POLICY[session.permission],
        sandbox: 'workspace-write'
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
    } catch (err) {
      disposed = true // expected exit, don't also report it as a crash
      conn.kill()
      throw new Error(
        `codex app-server handshake failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    return {
      async send(text: string, attachments: Attachment[] = []): Promise<void> {
        setStatus('running')
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
          void conn.request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(() => {})
        }
      },
      approve(requestId: string, allow: boolean): void {
        pendingApprovals.get(requestId)?.(allow)
      },
      async dispose(): Promise<void> {
        disposed = true
        conn.kill()
      }
    }
  }
}
