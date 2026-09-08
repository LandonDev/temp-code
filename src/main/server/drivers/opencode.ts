import type { AgentEvent, Attachment } from '@shared/events'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { modelVariants, probeCatalog } from './harness/opencodeCatalog'
import { createOpenCodeEngine } from './harness/opencodeEngine'
import { createTranslator } from './harness/toAgentEvent'

/**
 * OpenCode driver — one `opencode serve` per session over HTTP + SSE
 * (harness/opencodeEngine.ts). The engine's HarnessEvents go through the
 * translator; approvals come back through approve() as the engine's
 * numeric ids, questions through answer() as real question-requests.
 * ctx.session.model is the native `provider/model` id; the reasoning
 * level is sent as opencode's `variant` when the probed catalog lists it
 * for that model. Policy → opencode permission rules lives in
 * opencodeProtocol.buildOpenCodePermissionRules.
 */

const TOOL_NAMES: Record<string, string> = { shell: 'Bash', edit: 'Edit', read: 'Read', search: 'Grep', skill: 'Skill' }

let probed: Promise<unknown> | null = null
const ensureProbed = (): Promise<unknown> => (probed ??= probeCatalog())

export const opencodeDriver: HarnessDriver = {
  id: 'opencode',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session } = ctx
    let running = false
    let disposed = false
    let errored = false
    const emit = (event: AgentEvent): void => {
      if (disposed) return
      if (event.type === 'error') errored = true
      ctx.emit(event)
    }
    const translator = createTranslator(
      { ...ctx, emit },
      // opencode kinds are its own tool names (shell/edit/read/search/skill,
      // else the raw tool name), not the ACP kinds the translator knows.
      { toolName: (tool) => (tool.kind ? (TOOL_NAMES[tool.kind] ?? tool.kind) : undefined) }
    )

    const pendingQuestions = new Map<string, (answers: string[][] | null) => void>()
    const dismissQuestions = (): void => {
      for (const finish of [...pendingQuestions.values()]) finish(null)
    }

    const engine = createOpenCodeEngine({
      sessionId: session.id,
      cwd: session.cwd,
      permission: session.permission,
      resumeId: session.nativeId,
      onEvent: translator.push,
      onQuestion: ({ id, questions, callId }) => {
        const requestId = `opencode-q-${id}`
        emit({ type: 'question-request', requestId, questions, callId })
        emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
        pendingQuestions.set(requestId, (answers) => {
          pendingQuestions.delete(requestId)
          emit({ type: 'question-resolved', requestId, answers })
          emit({ type: 'status', status: 'running' })
          void engine.answerQuestion(id, answers)
        })
      }
    })

    await Promise.all([engine.start(), ensureProbed()])

    return {
      async send(text: string, attachments: Attachment[] = []): Promise<void> {
        if (disposed) throw new Error('opencode session is disposed')
        // Images ride as opencode file parts; other attachments as path references.
        const refs = attachments.filter((a) => a.kind !== 'image').map((a) => a.path)
        const body = refs.length ? `${text}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}` : text
        const turn = {
          model: session.model,
          variant: modelVariants(session.model).includes(session.reasoning) ? session.reasoning : undefined,
          text: body,
          attachments
        }
        if (running) {
          // opencode takes a prompt mid-turn as a steer.
          await engine.sendTurn(turn)
          return
        }
        running = true
        errored = false
        translator.beginTurn()
        try {
          await engine.sendTurn(turn)
        } catch (err) {
          // A dead server: let the registry boot a fresh handle and resend.
          if (err instanceof Error && err.message.includes('harness gone')) throw err
          if (!errored) emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
          translator.settleTurn()
          emit({ type: 'status', status: 'error' })
          return
        } finally {
          running = false
          dismissQuestions()
        }
        translator.settleTurn()
      },
      interrupt(): void {
        dismissQuestions()
        void engine.cancelTurn()
      },
      approve(requestId: string, allow: boolean): boolean {
        const id = translator.approvalNumber(requestId)
        if (id === undefined) return false
        return engine.respondApproval(id, allow ? 'allow' : 'deny')
      },
      answer(requestId: string, answers: string[][] | null): boolean {
        const finish = pendingQuestions.get(requestId)
        if (!finish) return false
        finish(answers)
        return true
      },
      async dispose(): Promise<void> {
        if (disposed) return
        dismissQuestions()
        disposed = true
        await engine.stop()
      }
    }
  }
}
