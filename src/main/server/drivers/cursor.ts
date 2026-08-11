import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'

/**
 * Cursor driver — wraps `cursor-agent -p --output-format stream-json`.
 * One process per turn; continuity via `--resume <chatId>`. Runs under the
 * user's own `cursor-agent login`.
 *
 * EXPERIMENTAL: stream-json event names verified only against public docs,
 * not a live run — see docs/PLAN.md Milestone 5.
 */

export const cursorDriver: HarnessDriver = {
  id: 'cursor',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx
    let chatId: string | null = session.nativeId
    let current: ReturnType<typeof spawn> | null = null

    emit({ type: 'status', status: 'idle' })

    return {
      async send(text: string): Promise<void> {
        emit({ type: 'user-text', text })
        emit({ type: 'status', status: 'running' })

        const args = ['-p', text, '--output-format', 'stream-json', '--model', session.model]
        if (chatId) args.push('--resume', chatId)

        const proc = spawn('cursor-agent', args, { cwd: session.cwd, env: { ...process.env } })
        current = proc

        createInterface({ input: proc.stdout! }).on('line', (line) => {
          if (!line.trim()) return
          let m: { type?: string; [k: string]: unknown }
          try {
            m = JSON.parse(line)
          } catch {
            return
          }
          switch (m.type) {
            case 'system': {
              const id = (m as { chatId?: string; session_id?: string }).chatId ?? m.session_id
              if (typeof id === 'string' && !chatId) {
                chatId = id
                ctx.setNativeId(id)
              }
              break
            }
            case 'assistant': {
              const content = (m.message as { content?: { type: string; text?: string }[] })
                ?.content
              for (const block of content ?? []) {
                if (block.type === 'text' && block.text) {
                  emit({ type: 'assistant-text', text: block.text, delta: true })
                }
              }
              break
            }
            case 'tool_call':
              emit({
                type: 'tool-call',
                callId: String(m.call_id ?? m.id ?? ''),
                name: String(m.name ?? m.subtype ?? 'tool'),
                input: m.args ?? m.input
              })
              break
            case 'result':
              emit({ type: 'turn-complete' })
              break
          }
        })

        proc.stderr &&
          createInterface({ input: proc.stderr }).on('line', (line) => {
            if (line.trim()) console.warn(`[cursor:${session.id}]`, line)
          })

        proc.on('exit', (code) => {
          current = null
          if (code !== 0) emit({ type: 'error', message: `cursor-agent exited with code ${code}` })
          emit({ type: 'status', status: code === 0 ? 'idle' : 'error' })
        })
      },
      interrupt(): void {
        current?.kill('SIGINT')
      },
      async dispose(): Promise<void> {
        current?.kill()
      }
    }
  }
}
