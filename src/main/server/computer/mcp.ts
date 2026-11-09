import { readFile } from 'node:fs/promises'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { z } from 'zod'
import { COMPUTER_SEARCH_HINT, COMPUTER_TOOLS, MAX_IMAGE_PARTS, computerToolJsonSchema } from '@shared/computer/tools'
import type { AppComputerAnswer } from '@shared/contract-computer'
import type { SessionMeta } from '@shared/events'
import { deferredTool } from '../addons/exposure'
import type { MacThreadTokens } from '../macTools'
import { toolUseIdOf } from '../macTools'
import { renderText, type ComputerToolOutcome } from './result'
import type { ComputerService } from './service'
import type { ComputerSessions } from './sessions'

/**
 * The four computer tools on every Mac thread's `app` server
 * (docs/computer-protocol.md "Tools on each harness"): in process for
 * Claude, deferred behind tool search so a thread that never touches an app
 * pays no schema; codex and Muse reach the same flow through the bridge
 * (rpc.ts). Box threads get none: computer use is unavailable there.
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

/** The four tools as the bridge lists them: tools.ts is the one source of their schemas. */
export function computerToolList(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return COMPUTER_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: computerToolJsonSchema(t.input) }))
}

const shapeOf = (input: z.ZodType): z.ZodRawShape => (input as unknown as { shape: z.ZodRawShape }).shape

/** The four tools for one claude thread, deferred behind tool search; [] where computer use is unavailable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computerTools(session: SessionMeta, host: ComputerHost | null = computerHooks.current): SdkMcpToolDefinition<any>[] {
  if (!host?.available()) return []
  return COMPUTER_TOOLS.map((spec) =>
    deferredTool(
      tool(
        spec.name,
        spec.description,
        shapeOf(spec.input),
        async (args, extra) => {
          // the queue parses again with the tool's full schema, refinements and all
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
          const outcome = await host.sessions.run({ threadId: session.id, callId: toolUseIdOf(extra), signal }, spec.name, args)
          return computerContent(outcome, 'parts')
        },
        { searchHint: COMPUTER_SEARCH_HINT }
      )
    )
  )
}
