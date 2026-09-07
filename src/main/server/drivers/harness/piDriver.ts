import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Attachment } from '@shared/events'
import type { DriverCtx, DriverHandle, HarnessDriver } from '../types'
import {
  bindSession,
  cancelTurn,
  hasActiveTurn,
  respondApproval,
  sendTurn,
  steerTurn,
  stopSession
} from './piFamily'
import type { PiFlavor } from './piFlavor'
import { SUPPORTED_PI_IMAGE_MIME_TYPES, type Attachment as PiAttachment } from './piProtocol'
import { createTranslator } from './toAgentEvent'
import type { HarnessEvent } from './types'

/**
 * HarnessDriver over the pi family engine (piFamily.ts) — one factory,
 * two registrations (pi.ts, omp.ts). The engine keeps one `--mode rpc`
 * child per session across turns; this shell maps the server contract
 * onto it:
 *
 *   send       first message → sendTurn (resolves once pi accepted the
 *              prompt; the turn streams on and settles the translator).
 *              While a turn runs → the engine's steer frame, no interrupt.
 *   interrupt  abort frame + synthesized completion (cancelTurn)
 *   dispose    kills the child (stopSession)
 *
 * PERMISSION is inert — pi and omp have no permission modes; pi's own
 * extension prompts are the only gate:
 *
 *   | policy | pi/omp behaviour              |
 *   |--------|-------------------------------|
 *   | safe   | pi's defaults, no extra flags |
 *   | edits  | same                          |
 *   | auto   | same                          |
 *
 * When pi itself asks (an extension confirm/select/input/editor frame)
 * the question goes through ctx.requestApproval so the user still sees
 * a card; deny cancels the frame.
 */
export function createPiDriver(flavor: PiFlavor): HarnessDriver {
  return {
    id: flavor.id,
    start: (ctx) => start(flavor, ctx)
  }
}

async function start(flavor: PiFlavor, ctx: DriverCtx): Promise<DriverHandle> {
  // Fail here, not on the first send: the registry turns a start failure
  // into an error event and status, a send failure only rejects the RPC.
  await flavor.resolveBinary()
  const { session, emit } = ctx
  const translator = createTranslator(ctx)
  if (session.nativeId) bindSession(flavor, session.id, session.nativeId, session.cwd)

  let disposed = false
  let turn: Promise<void> | null = null

  const askUser = async (ev: Extract<HarnessEvent, { type: 'approval.requested' }>): Promise<void> => {
    const allow = await ctx.requestApproval({
      toolName: `${flavor.label} extension`,
      input: {},
      title: ev.title,
      callId: ev.callId
    })
    respondApproval(flavor, session.id, ev.requestId, allow ? 'allow' : 'deny')
  }

  const onEvent = (event: HarnessEvent): void => {
    if (disposed) return
    // pi's extension prompts go through the registry's approval path,
    // which emits the request/resolved pair itself.
    if (event.type === 'approval.requested') {
      void askUser(event)
      return
    }
    if (event.type === 'approval.resolved') return
    translator.push(event)
  }

  const base = {
    sessionId: session.id,
    cwd: session.cwd,
    model: session.model,
    modelSettings: { thinking: session.reasoning }
  }

  return {
    async send(text: string, attachments: Attachment[] = []): Promise<void> {
      const message = await piMessage(text, attachments)
      if (turn) {
        if (!hasActiveTurn(flavor, session.id)) {
          // still booting the child: the registry front-queues on this text
          throw new Error(`${flavor.label} session is still running a turn`)
        }
        await steerTurn(flavor, { ...base, ...message })
        return
      }
      translator.beginTurn()
      let accepted!: () => void
      const acceptedP = new Promise<void>((resolve) => (accepted = resolve))
      const run = sendTurn(flavor, { ...base, ...message, onEvent, onAccepted: accepted })
      turn = run
      let taken = false
      void acceptedP.then(() => (taken = true))
      run
        .catch((err: unknown) => {
          // Before acceptance the failure is send()'s to throw; after it
          // the engine has already put a session.error on the stream.
          if (!taken || disposed) return
          emit({ type: 'status', status: 'error', detail: err instanceof Error ? err.message : String(err) })
        })
        .finally(() => {
          if (turn === run) turn = null
          if (!disposed) translator.settleTurn()
        })
      await Promise.race([acceptedP, run])
    },
    interrupt(): void {
      void cancelTurn(flavor, session.id)
    },
    async dispose(): Promise<void> {
      disposed = true
      await stopSession(flavor, session.id)
    }
  }
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** Images pi accepts ride inline as base64 on the prompt/steer frame;
 *  everything else becomes a path reference in the text, as cursor does. */
async function piMessage(
  text: string,
  attachments: Attachment[]
): Promise<{ text: string; attachments: PiAttachment[] }> {
  const images: PiAttachment[] = []
  const refs: string[] = []
  for (const a of attachments) {
    const mimeType = (a.mime ?? IMAGE_MIME_BY_EXT[extname(a.path).toLowerCase()] ?? '').toLowerCase()
    if (a.kind === 'image' && SUPPORTED_PI_IMAGE_MIME_TYPES.has(mimeType)) {
      try {
        const data = await readFile(a.path)
        images.push({ id: a.path, name: a.name, mimeType, kind: 'image', size: data.byteLength, data: data.toString('base64') })
        continue
      } catch {
        // unreadable: fall through to a path reference
      }
    }
    refs.push(a.path)
  }
  return {
    text: refs.length ? `${text}\n\n${refs.map((p) => `Attached file: ${p}`).join('\n')}` : text,
    attachments: images
  }
}
