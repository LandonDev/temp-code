import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'

/**
 * Codex driver — drives `codex app-server`: bidirectional JSON-RPC 2.0 over
 * stdio, newline-delimited. Runs under the user's ChatGPT login
 * (`codex login`); we never touch credentials.
 *
 * EXPERIMENTAL: transport is solid; method/event names follow the codex-rs
 * app-server protocol and must be verified against the installed CLI
 * (`codex app-server` docs) — see docs/PLAN.md Milestone 5.
 */

interface RpcPending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

class AppServerConn {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, RpcPending>()
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {}

  constructor(cwd: string, onExit: (code: number | null) => void) {
    // Resolve the real binary, not the shell wrapper (Aliax lesson: shell
    // functions shadow `codex`; GUI apps also need a login-shell PATH).
    this.proc = spawn('codex', ['app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    })
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited (${code})`))
      this.pending.clear()
      onExit(code)
    })
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.trim()) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
          else p.resolve(msg.result)
        }
      } else if (typeof msg.method === 'string') {
        this.onNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>)
      }
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(frame + '\n')
    })
  }

  kill(): void {
    this.proc.kill()
  }
}

export const codexDriver: HarnessDriver = {
  id: 'codex',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx
    let conversationId: string | null = session.nativeId

    const conn = new AppServerConn(session.cwd, (code) => {
      if (code !== 0) emit({ type: 'error', message: `codex app-server exited with code ${code}` })
      emit({ type: 'status', status: code === 0 ? 'done' : 'error' })
    })

    conn.onNotification = (method, params) => {
      // codex/event carries an EventMsg payload in params.msg.
      if (method !== 'codex/event') return
      const m = (params.msg ?? params) as { type?: string; [k: string]: unknown }
      switch (m.type) {
        case 'agent_message_delta':
          emit({ type: 'assistant-text', text: String(m.delta ?? ''), delta: true })
          break
        case 'agent_message':
          emit({ type: 'assistant-text', text: String(m.message ?? ''), delta: false })
          break
        case 'agent_reasoning_delta':
          emit({ type: 'thinking', text: String(m.delta ?? ''), delta: true })
          break
        case 'exec_command_begin':
          emit({
            type: 'tool-call',
            callId: String(m.call_id ?? ''),
            name: 'shell',
            input: m.command
          })
          break
        case 'exec_command_end':
          emit({
            type: 'tool-result',
            callId: String(m.call_id ?? ''),
            output: String(m.aggregated_output ?? m.stdout ?? ''),
            isError: m.exit_code !== 0
          })
          break
        case 'task_complete':
          emit({ type: 'turn-complete' })
          emit({ type: 'status', status: 'idle' })
          break
        case 'error':
          emit({ type: 'error', message: String(m.message ?? 'unknown codex error') })
          break
      }
    }

    try {
      await conn.request('initialize', {
        clientInfo: { name: 'temp-code', title: 'temp-code', version: '0.0.1' }
      })
      if (!conversationId) {
        const res = (await conn.request('newConversation', {
          model: session.model,
          cwd: session.cwd,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          config: { model_reasoning_effort: session.reasoning }
        })) as { conversationId?: string }
        conversationId = res.conversationId ?? null
        if (conversationId) ctx.setNativeId(conversationId)
      }
      await conn.request('addConversationListener', { conversationId })
      emit({ type: 'status', status: 'idle' })
    } catch (err) {
      emit({
        type: 'error',
        message: `codex handshake failed (is codex installed + logged in?): ${err instanceof Error ? err.message : err}`
      })
      emit({ type: 'status', status: 'error' })
    }

    return {
      async send(text: string): Promise<void> {
        emit({ type: 'user-text', text })
        emit({ type: 'status', status: 'running' })
        await conn.request('sendUserMessage', {
          conversationId,
          items: [{ type: 'text', data: { text } }]
        })
      },
      interrupt(): void {
        void conn.request('interruptConversation', { conversationId })
      },
      async dispose(): Promise<void> {
        conn.kill()
      }
    }
  }
}
