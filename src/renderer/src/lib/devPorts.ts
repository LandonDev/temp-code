import { useStore } from 'zustand'
import { macUrl, type PortForwardInfo } from '@server/shared/contract-ports'
import type { ThreadResource } from '@server/shared/contract-resources'
import { macBridgeStore } from './macBridge'
import { isWebMode } from './nativeWeb'
import { threadResourcesStore } from './threadResources'

/**
 * Where a dev server opens from this machine (docs/box.md "Dev servers on the
 * box"). A port on this Mac opens as it is ("Open in browser"); one on another
 * host opens through its forward here ("Open on the Mac", the wording the file
 * rows use), on the number this Mac bound, which may sit above the host's when
 * this Mac's own server holds that one. The web build has no Mac to open on.
 */

export interface PortOpen {
  label: 'Open in browser' | 'Open on the Mac'
  url: string
  /** The number here. */
  port: number
  /** The number on its host, when it differs ("5173 is taken here"). */
  movedFrom: number | null
}

/** How a port opens here, given where it lives and its forwards; null when it cannot. */
export function portOpen(hostPort: number, environmentId: string, forwards: readonly PortForwardInfo[] | undefined, localId: string | null): PortOpen | null {
  if (!localId) return null
  if (environmentId === localId) return { label: 'Open in browser', url: macUrl(hostPort), port: hostPort, movedFrom: null }
  const f = forwards?.find((x) => x.environmentId === localId && x.macPort !== null)
  if (!f || f.macPort === null) return null
  return { label: 'Open on the Mac', url: macUrl(f.macPort), port: f.macPort, movedFrom: f.macPort !== hostPort ? hostPort : null }
}

export const rowOpen = (row: ThreadResource, localId: string | null): PortOpen | null =>
  row.kind === 'port' ? portOpen(Number(row.identifier), row.environmentId, row.forwards, localId) : null

/** What a port row says under its label: "localhost:5174 here · 5173 is taken here", or why it is not forwarded. */
export function portLine(row: ThreadResource, localId: string | null): string | null {
  if (row.kind !== 'port') return null
  const open = rowOpen(row, localId)
  if (open) return `localhost:${open.port}${open.movedFrom ? ` · ${open.movedFrom} is taken here` : ''}`
  const err = row.forwards?.find((f) => f.environmentId === localId)?.error
  return err ? `Not forwarded: ${err}` : row.environmentId === localId ? null : 'Not forwarded to this Mac'
}

/** The live port a shell call opened, by its call id (a subagent's row is filed under its root, so every thread is searched). */
export function portOfCall(bySession: Record<string, ThreadResource[]>, callId: string): ThreadResource | null {
  for (const rows of Object.values(bySession)) for (const r of rows) if (r.kind === 'port' && r.callId === callId && !r.removedAt) return r
  return null
}

/** The transcript row's link: how the port its call opened opens here. */
export function useCallPortOpen(callId: string | undefined): PortOpen | null {
  const localId = useStore(macBridgeStore, (s) => s.localId)
  const row = useStore(threadResourcesStore, (s) => (callId ? portOfCall(s.bySession, callId) : null))
  if (!row || isWebMode()) return null
  return rowOpen(row, localId)
}

/** Open a dev server's URL in the default browser (the window's open handler hands it to the system). */
export function openUrl(url: string): void {
  window.open(url, '_blank', 'noopener')
}
