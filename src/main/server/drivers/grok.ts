import { nanoid } from 'nanoid'
import type { AgentEvent, Attachment, PermissionPolicy } from '@shared/events'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import { resolveGrokBinary } from './harness/child'
import {
  bindGrokSession,
  cancelGrokTurn,
  forgetGrokSession,
  respondGrokApproval,
  sendGrokTurn
} from './harness/grokEngine'
import type { GrokAskQuestion, RuntimeMode } from './harness/grokProtocol'
import { createTranslator } from './harness/toAgentEvent'

/**
 * Grok Build driver — `grok agent stdio` over ACP, one child per session
 * kept alive across turns (harness/grokEngine.ts). The engine's
 * HarnessEvents go through the translator; approvals come back through
 * approve() as the engine's numeric request ids, questions through
 * answer() as real question-requests.
 *
 * Policy → grok access mode (grokProtocol.pickAutoOption decides per
 * request; full-access also passes --always-approve and yoloMode):
 *
 *   | policy | grok mode         | the user is asked for                   |
 *   |--------|-------------------|-----------------------------------------|
 *   | safe   | supervised        | every permission request                |
 *   | edits  | auto-accept-edits | execute / fetch / other; edits auto-run |
 *   | auto   | full-access       | nothing                                 |
 */
const RUNTIME_MODE: Record<PermissionPolicy, RuntimeMode> = {
  safe: 'supervised',
  edits: 'auto-accept-edits',
  auto: 'full-access'
}

/** Efforts grok's --reasoning-effort accepts; others are not sent. */
const GROK_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh'])

export const grokDriver: HarnessDriver = {
  id: 'grok',

  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session } = ctx
    await resolveGrokBinary()

    let running = false
    let disposed = false
    let errored = false
    const emit = (event: AgentEvent): void => {
      if (disposed) return
      if (event.type === 'error') errored = true
      ctx.emit(event)
    }
    const translator = createTranslator({ ...ctx, emit })
    if (session.nativeId) bindGrokSession(session.id, session.nativeId, session.cwd)

    const pendingQuestions = new Map<string, (answers: string[][] | null) => void>()
    const askQuestion = (questions: GrokAskQuestion[]): Promise<string[][] | null> =>
      new Promise((resolve) => {
        const requestId = `q-${nanoid(8)}`
        emit({
          type: 'question-request',
          requestId,
          questions: questions.map((q) => ({
            question: q.question,
            multiSelect: q.multiSelect,
            allowFreeform: true,
            options: q.options.map((label) => ({ label }))
          }))
        })
        emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
        pendingQuestions.set(requestId, (answers) => {
          pendingQuestions.delete(requestId)
          emit({ type: 'question-resolved', requestId, answers })
          emit({ type: 'status', status: 'running' })
          resolve(answers)
        })
      })
    const dismissQuestions = (): void => {
      for (const finish of [...pendingQuestions.values()]) finish(null)
    }

    return {
      async send(text: string, attachments: Attachment[] = []): Promise<void> {
        if (disposed) throw new Error('grok session is disposed')
        if (running) throw new Error('grok session is still running a turn')
        running = true
        errored = false
        translator.beginTurn()
        // grok's prompt takes text only — attachments ride as path references.
        const refs = attachments.map((a) => a.path)
        const body = refs.length
          ? `${text}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}`
          : text
        try {
          await sendGrokTurn({
            sessionId: session.id,
            cwd: session.cwd,
            model: session.model,
            modelSettings: GROK_EFFORTS.has(session.reasoning)
              ? { effort: session.reasoning }
              : undefined,
            runtimeMode: RUNTIME_MODE[session.permission],
            text: body,
            onEvent: translator.push,
            onQuestion: askQuestion
          })
        } catch (err) {
          // prompt failures already arrived as session.error; anything
          // earlier (spawn, auth, session/new) surfaces here.
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
        void cancelGrokTurn(session.id)
      },
      approve(requestId: string, allow: boolean): boolean {
        const id = translator.approvalNumber(requestId)
        if (id === undefined) return false
        return respondGrokApproval(session.id, id, allow ? 'allow' : 'deny')
      },
      answer(requestId: string, answers: string[][] | null): boolean {
        const finish = pendingQuestions.get(requestId)
        if (!finish) return false
        finish(answers)
        return true
      },
      async dispose(): Promise<void> {
        disposed = true
        dismissQuestions()
        await forgetGrokSession(session.id)
      }
    }
  }
}
