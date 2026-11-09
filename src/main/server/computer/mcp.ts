import { readFile } from 'node:fs/promises'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { z } from 'zod'
import { COMPUTER_BRIDGE_NOTE, COMPUTER_SEARCH_HINT, COMPUTER_TOOLS, MAX_IMAGE_PARTS, computerToolJsonSchema } from '@shared/computer/tools'
import type { AppComputerAnswer } from '@shared/contract-computer'
import type { SessionMeta } from '@shared/events'
import { deferredTool } from '../addons/exposure'
import type { MacThreadTokens } from '../macTools'
import { toolUseIdOf } from '../macTools'
import { computerBridgeHooks } from './bridge'
import { renderText, type ComputerToolOutcome } from './result'
import type { ComputerService } from './service'
import type { ComputerSessions } from './sessions'

/**
 * The four computer tools on every Mac thread's `app` server
 * (docs/computer-protocol.md "Tools on each harness"): in process for
 * Claude, deferred behind tool search so a thread that never touches an app
 * pays no schema; codex and Muse reach the same flow through the bridge
 * (rpc.ts). A box thread gets them only when its bridge names a Mac that
 * offers computer use (computer/bridge.ts): the same four, each description
 * followed by COMPUTER_BRIDGE_NOTE, its calls carried to the Mac.
 */

export interface ComputerHost {
  /** binary.ts's verdict, asked again at every harness start */
  available(): boolean
  sessions: ComputerSessions
  service: ComputerService
  /** per-thread tokens of purpose `computer`: a bridge never acts as another thread */
  tokens: MacThreadTokens
}

/** Set by index.ts on a host where computer use may run; null elsewhere. */
export const computerHooks: { current: ComputerHost | null } = { current: null }

export const COMPUTER_APP_TOOLS: readonly string[] = COMPUTER_TOOLS.map((t) => `mcp__app__${t.name}`)

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** One text part, then one image part per picture up to MAX_IMAGE_PARTS (with `parts`). */
export async function computerContent(o: ComputerToolOutcome, images: 'parts' | 'none'): Promise<{ content: Content[]; isError: boolean }> {
  const content: Content[] = [{ type: 'text', text: renderText(o) }]
  if (images === 'parts')
    for (const shot of o.shots.slice(0, MAX_IMAGE_PARTS))
      content.push({ type: 'image', data: (await readFile(shot.path)).toString('base64'), mimeType: shot.mimeType })
  return { content, isError: o.isError }
}

/** The bridge's answer: the same text, the pictures as base64 with their labels when asked for. */
export async function computerAnswer(o: ComputerToolOutcome, images: 'parts' | 'none'): Promise<AppComputerAnswer> {
  const parts =
    images === 'parts'
      ? await Promise.all(
          o.shots.slice(0, MAX_IMAGE_PARTS).map(async (s) => ({
            label: s.label,
            data: (await readFile(s.path)).toString('base64'),
            mimeType: s.mimeType,
            width: s.width,
            height: s.height
          }))
        )
      : []
  return { text: renderText(o), isError: o.isError, images: parts }
}

/** The four tools as the bridge lists them: tools.ts is the one source of their schemas; `bridged` adds the Mac's note. */
export function computerToolList(opts: { bridged?: boolean } = {}): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const note = opts.bridged ? COMPUTER_BRIDGE_NOTE : ''
  return COMPUTER_TOOLS.map((t) => ({ name: t.name, description: t.description + note, inputSchema: computerToolJsonSchema(t.input) }))
}

const shapeOf = (input: z.ZodType): z.ZodRawShape => (input as unknown as { shape: z.ZodRawShape }).shape

/**
 * The four tools for one claude thread, deferred behind tool search: run
 * here where computer use is available, else carried to the thread's Mac when
 * its bridge names one that offers it; [] otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computerTools(session: SessionMeta, host: ComputerHost | null = computerHooks.current, bridge = computerBridgeHooks.current): SdkMcpToolDefinition<any>[] {
  const local = host?.available() ? host : null
  if (!local && !bridge?.offered(session.id)) return []
  return COMPUTER_TOOLS.map((spec) =>
    deferredTool(
      tool(
        spec.name,
        local ? spec.description : spec.description + COMPUTER_BRIDGE_NOTE,
        shapeOf(spec.input),
        async (args, extra) => {
          // the queue parses again with the tool's full schema, refinements and all
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
          const ctx = { threadId: session.id, callId: toolUseIdOf(extra), signal }
          const outcome = local ? await local.sessions.run(ctx, spec.name, args) : await bridge!.run(ctx, spec.name, args)
          return computerContent(outcome, 'parts')
        },
        { searchHint: COMPUTER_SEARCH_HINT }
      )
    )
  )
}
