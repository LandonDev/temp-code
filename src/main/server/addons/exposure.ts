import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionMeta } from '@shared/events'
import type { AddonCallResult } from './addonWire'
import { visibleTools, type ScopeStore } from './scope'

/**
 * Claude threads get each add-on tool as a real tool on their `app` server,
 * `mcp__app__<addon>__<tool>`, deferred behind tool search (plan section 5).
 * The tools follow the store live: a registration or a removal on the
 * running server sends `notifications/tools/list_changed`, and the CLI
 * lists the server again before its next request (step 0, 2026-11-08: a
 * tool registered after a thread's first turn was found and called on its
 * second). The app's own tools are always loaded (`alwaysLoad`); these are
 * not.
 */

/** The live server as exposure needs it: the SDK's McpServer. */
export interface McpServerLike {
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: z.ZodType; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> },
    cb: (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<unknown>
  ): { remove(): void }
}

export type AddonCaller = (addonId: string, tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal }) => Promise<AddonCallResult>

export interface ExposureDeps {
  store: ScopeStore & { onChange(fn: () => void): () => void }
  host: { onChange(fn: (addonId: string) => void): () => void }
  workspaceOf: (sessionId: string) => string | null
  call: AddonCaller
}

/** A tool definition from the Agent SDK's `tool()`, deferred behind tool search even on an `alwaysLoad` server (the server spreads the tool's `_meta` over its own). The skills core reuses it. */
export function deferredTool<T extends { _meta?: Record<string, unknown> }>(def: T): T {
  def._meta = { ...def._meta, 'anthropic/alwaysLoad': false }
  return def
}

/**
 * A downstream JSON Schema as the SDK server lists it, verbatim. Arguments
 * pass through unvalidated (the downstream server validates). A schema with
 * no `type` gets `type: 'object'`; `$schema` is dropped.
 */
export function inputSchemaOf(json: Record<string, unknown>): z.ZodType {
  const { $schema: _, ...rest } = json
  return z.looseObject({}).meta({ ...rest, type: 'object' })
}

type Binding = { addonId: string; tool: string; key: string; register: () => { remove(): void } }
type Attachment = { sessionId: string; instance: McpServerLike; listed: Map<string, { binding: Binding; handle: { remove(): void } }>; released: boolean }

export class AddonExposure {
  private readonly attached = new Map<string, Attachment>()
  private readonly stops: (() => void)[] = []

  constructor(private readonly deps: ExposureDeps) {
    this.stops.push(deps.store.onChange(() => this.syncAll()))
    this.stops.push(deps.host.onChange(() => this.syncAll()))
  }

  /** Register the thread's add-on tools on its app server and keep them in step; a later attach for the same session replaces this one. The answer releases this attachment only. */
  attach(session: SessionMeta, instance: McpServerLike): () => void {
    const a: Attachment = { sessionId: session.id, instance, listed: new Map(), released: false }
    this.attached.set(session.id, a)
    this.sync(a)
    return () => {
      a.released = true
      if (this.attached.get(session.id) === a) this.attached.delete(session.id)
    }
  }

  /** The tools this session lists now, exposed name → { addonId, tool }. */
  listed(sessionId: string): Map<string, { addonId: string; tool: string }> {
    const a = this.attached.get(sessionId)
    return new Map([...(a?.listed ?? [])].map(([name, { binding }]) => [name, { addonId: binding.addonId, tool: binding.tool }]))
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.attached.clear()
  }

  private syncAll(): void {
    for (const a of this.attached.values()) this.sync(a)
  }

  private sync(a: Attachment): void {
    if (a.released) return
    const want = this.bindings(a)
    for (const [name, entry] of [...a.listed]) {
      if (want.get(name)?.key === entry.binding.key) continue
      try {
        entry.handle.remove()
      } catch {
        // the server already closed
      }
      a.listed.delete(name)
    }
    for (const [name, binding] of want) {
      if (a.listed.has(name)) continue
      try {
        a.listed.set(name, { binding, handle: binding.register() })
      } catch (error) {
        console.warn(`[addons] could not list ${name} for ${a.sessionId}: ${(error as Error).message}`)
      }
    }
  }

  private bindings(a: Attachment): Map<string, Binding> {
    const out = new Map<string, Binding>()
    for (const { row, tool } of visibleTools(this.deps.store, this.deps.workspaceOf(a.sessionId))) {
      const hint = row.description || row.name
      const schema = createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex')
      const key = JSON.stringify([row.id, tool.name, tool.description, schema, tool.readOnly ?? null, hint])
      const addonId = row.id
      out.set(tool.exposed, {
        addonId,
        tool: tool.name,
        key,
        register: () =>
          a.instance.registerTool(
            tool.exposed,
            {
              description: tool.description,
              inputSchema: inputSchemaOf(tool.inputSchema),
              ...(tool.readOnly !== undefined ? { annotations: { readOnlyHint: tool.readOnly } } : {}),
              _meta: { 'anthropic/searchHint': hint }
            },
            async (args, extra) => {
              try {
                return await this.deps.call(addonId, tool.name, args, { signal: extra.signal })
              } catch (error) {
                return { content: [{ type: 'text', text: (error as Error).message }], isError: true }
              }
            }
          )
      })
    }
    return out
  }
}
