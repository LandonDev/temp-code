import type { Attachment, ToolPreview } from '@shared/events'
import type { DriverCtx, DriverHandle, HarnessDriver } from './types'
import {
  bindFxSession,
  cancelFxTurn,
  respondFxApproval,
  sendFxTurn,
  stopFxSession
} from './harness/fxEngine'
import { createTranslator, type ToolFace } from './harness/toAgentEvent'

/**
 * fx driver — `fx acp` over stdio, one child per session, resumed through
 * the ACP session id kept in SessionMeta.nativeId. The engine
 * (harness/fxEngine.ts) speaks the protocol; this shell maps it onto
 * HarnessDriver.
 *
 * PERMISSION is inert. fx has no permission modes the client can drive:
 * it runs its own `code` mode and any prompt that still reaches us is
 * answered allow inline (harness/fxEngine.ts handlePermission). The user
 * never sees an approval-request from fx.
 *
 *   | policy | fx behaviour                  |
 *   |--------|-------------------------------|
 *   | safe   | code mode, auto-allow         |
 *   | edits  | same                          |
 *   | auto   | same                          |
 *
 * Reasoning: ignored (fx's per-model effort is not wired here).
 * Model: ctx.session.model is the native fx id ("zai/glm-5.2").
 * Attachments: fx takes text only; every attachment degrades to a path
 * reference the model can read itself, as cursor does.
 */

/** Fallback input for a tool the engine sent none for (a permission
 *  request before its result blob): what the mined preview holds. */
function toolInputFromFace(tool: ToolFace): unknown {
  const preview: ToolPreview | undefined = tool.preview
  if (!preview) return undefined
  if ((preview.kind === 'read' || preview.kind === 'write') && preview.path) return { path: preview.path }
  if (preview.kind === 'search' && preview.query) return { query: preview.query }
  if (preview.kind === 'shell' && preview.title) return { command: preview.title }
  return undefined
}

export const fxDriver: HarnessDriver = {
  id: 'fx',
  async start(ctx: DriverCtx): Promise<DriverHandle> {
    const { session, emit } = ctx
    const translator = createTranslator(ctx, { toolInput: toolInputFromFace })
    if (session.nativeId) bindFxSession(session.id, session.nativeId, session.cwd)

    let running = false
    let disposed = false

    const runTurn = async (text: string): Promise<void> => {
      try {
        await sendFxTurn({
          sessionId: session.id,
          cwd: session.cwd,
          model: session.model,
          text,
          onEvent: translator.push
        })
      } catch (err) {
        if (!disposed) emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        running = false
        if (!disposed) translator.settleTurn()
      }
    }

    return {
      async send(text: string, attachments: Attachment[] = []): Promise<void> {
        if (running) throw new Error('fx session is still running a turn')
        running = true
        translator.beginTurn()
        const refs = attachments.map((a) => a.path)
        void runTurn(
          refs.length ? `${text}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}` : text
        )
      },
      interrupt(): void {
        void cancelFxTurn(session.id)
      },
      approve(requestId: string, allow: boolean): boolean {
        const number = translator.approvalNumber(requestId)
        if (number === undefined) return false
        respondFxApproval(session.id, number, allow ? 'allow' : 'deny')
        return true
      },
      async dispose(): Promise<void> {
        disposed = true
        await stopFxSession(session.id)
      }
    }
  }
}
