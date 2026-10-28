/**
 * Appshots: a double-⌘ over another app lands that app's window, as an
 * image plus its accessibility text, in a chat's composer. Main captures
 * and pushes the files over preload; this module routes the arrival to a
 * session, stages it for that session's composer, plays the shutter and
 * drives the fly-in. Settings live in the server's settings table.
 */
import { useSyncExternalStore } from 'react'
import {
  DEFAULT_APPSHOT_SETTINGS,
  type AppshotDestination,
  type AppshotSettings
} from '@server/shared/appshots'
import { appshots as bridge, type AppshotCapture, type AppshotPermissions } from './native'
import { OPEN_SETTINGS_EVENT } from './monaco/debugTab'
import { lastProjectPath } from './recents'
import type { Attachment } from './session'
import { registry } from './connection'
import { projectForCwd } from './tcserver/projects'
import { sessionStore } from './tcserver/store'
import type { SessionMeta, WireSessionMeta } from './tcserver/types'
import { workspaceStore } from './tcserver/workspaces'
import shutterUrl from '../assets/shutter.wav?url'

export type AppshotFlash = {
  sessionId: string
  attachment: Attachment
  /** changes per capture, so the overlay remounts and replays */
  key: number
}

let settings: AppshotSettings = DEFAULT_APPSHOT_SETTINGS
let permissions: AppshotPermissions | null = null
let flash: AppshotFlash | null = null
let activeSessionId: string | null = null
const pending = new Map<string, Attachment[]>()
const composers = new Map<string, (files: Attachment[]) => void>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

// ── settings ─────────────────────────────────────────────────────────

export function useAppshotSettings(): AppshotSettings {
  return useSyncExternalStore(subscribe, () => settings)
}

/** Whether the host's settings have answered, why the load or the last
 *  write failed, and which setting that write changed. */
export type AppshotSettingsStatus = {
  loaded: boolean
  loadError: string | null
  writeError: { key: keyof AppshotSettings; message: string } | null
}

let status: AppshotSettingsStatus = { loaded: false, loadError: null, writeError: null }
/** What the host last confirmed holding: a failed write goes back to it. */
let stored: AppshotSettings = DEFAULT_APPSHOT_SETTINGS
let writes: Promise<void> = Promise.resolve()
/** Writes queued per setting, this one's included. */
const queued: Partial<Record<keyof AppshotSettings, number>> = {}

function setStatus(patch: Partial<AppshotSettingsStatus>): void {
  status = { ...status, ...patch }
  emit()
}

export function useAppshotSettingsStatus(): AppshotSettingsStatus {
  return useSyncExternalStore(subscribe, () => status)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Optimistic: the page flips at once, the server row follows. A write is
 *  refused until the stored settings have loaded (it would send defaults
 *  over them). Writes go one at a time, each sending the whole set as it
 *  stands when its turn comes, so a failed one put back (to what the host
 *  last stored) is never overwritten by a later one's copy. */
export function setAppshotSettings(patch: Partial<AppshotSettings>): void {
  if (!status.loaded) return
  settings = { ...settings, ...patch }
  setStatus({ writeError: null })
  const keys = Object.keys(patch) as (keyof AppshotSettings)[]
  for (const k of keys) queued[k] = (queued[k] ?? 0) + 1
  writes = writes.then(async () => {
    const sent = settings
    try {
      // Appshots are this Mac's feature: its settings and chats live on the local server.
      await registry.primary().request('appshots.set', { settings: sent })
      stored = sent
    } catch (err) {
      // A setting a later queued write changes again keeps that newer choice.
      const back = keys.filter((k) => queued[k] === 1)
      settings = { ...settings, ...Object.fromEntries(back.map((k) => [k, stored[k]])) }
      setStatus({ writeError: { key: keys[0], message: message(err) } })
    } finally {
      for (const k of keys) queued[k] = (queued[k] ?? 1) - 1
    }
  })
}

/** Ask the host for the stored settings, waiting for the link to open. */
export async function loadAppshotSettings(): Promise<void> {
  setStatus({ loadError: null })
  try {
    settings = await registry.primary().request<AppshotSettings>('appshots.get', {}, { retry: true })
    stored = settings
    setStatus({ loaded: true })
  } catch (err) {
    setStatus({ loadError: message(err) })
  }
}

/** Test seam. */
export function resetAppshotSettingsForTests(): void {
  settings = DEFAULT_APPSHOT_SETTINGS
  stored = DEFAULT_APPSHOT_SETTINGS
  writes = Promise.resolve()
  for (const k of Object.keys(queued)) delete queued[k as keyof AppshotSettings]
  status = { loaded: false, loadError: null, writeError: null }
}

// ── permissions ──────────────────────────────────────────────────────

export function useAppshotPermissions(): AppshotPermissions | null {
  return useSyncExternalStore(subscribe, () => permissions)
}

export async function refreshAppshotPermissions(prompt = false): Promise<AppshotPermissions> {
  const next = await bridge.permissions(prompt)
  permissions = next
  emit()
  return next
}

// ── routing ──────────────────────────────────────────────────────────

/** SessionPane reports the focused, visible session; "automatic" lands there. */
export function noteActiveSession(id: string | null): void {
  activeSessionId = id
}

function liveChats(): SessionMeta[] {
  return sessionStore.metas().filter((m) => !m.parentId && !m.archived && m.threadType === 'chat')
}

function lastChat(): SessionMeta | undefined {
  return liveChats().sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

async function createChat(): Promise<string | null> {
  const projects = workspaceStore.projects.filter((p) => !p.archived)
  const selected = lastProjectPath()
  const project =
    (selected ? projectForCwd(selected, projects) : undefined) ??
    projects.find((p) => p.id === lastChat()?.projectId) ??
    projects[0]
  if (!project && !selected) return null
  const wire = await registry.primary().request<WireSessionMeta>('session.create', {
    threadType: 'chat',
    agentType: 'implementer',
    ...(project ? { projectId: project.id } : { cwd: selected })
  })
  // The push opens the thread behind the user's work; the drop is an
  // explicit ask, so it comes forward too.
  const meta = { ...wire, environmentId: registry.primary().environmentId }
  sessionStore.adopt(meta)
  sessionStore.requestOpen(meta.id)
  return meta.id
}

async function resolveTarget(destination: AppshotDestination): Promise<string | null> {
  if (destination === 'automatic') {
    const active = activeSessionId ? sessionStore.metaOf(activeSessionId) : null
    if (active && !active.archived) {
      sessionStore.requestOpen(active.id)
      return active.id
    }
  } else if (destination === 'last-chat') {
    const last = lastChat()
    if (last) {
      sessionStore.requestOpen(last.id)
      return last.id
    }
  }
  return createChat()
}

// ── staging ──────────────────────────────────────────────────────────

/**
 * A composer takes the appshots staged for its session: those already
 * waiting, then each later arrival while it stays mounted.
 */
export function subscribeAppshots(
  sessionId: string,
  onStaged: (files: Attachment[]) => void
): () => void {
  composers.set(sessionId, onStaged)
  const waiting = pending.get(sessionId)
  if (waiting?.length) {
    pending.delete(sessionId)
    onStaged(waiting)
  }
  return () => {
    if (composers.get(sessionId) === onStaged) composers.delete(sessionId)
  }
}

function stage(sessionId: string, attachment: Attachment): void {
  const composer = composers.get(sessionId)
  if (composer) {
    composer([attachment])
    return
  }
  pending.set(sessionId, [...(pending.get(sessionId) ?? []), attachment])
}

export function useAppshotFlash(sessionId: string): AppshotFlash | null {
  const current = useSyncExternalStore(subscribe, () => flash)
  return current?.sessionId === sessionId ? current : null
}

/** The fly-in calls this once it has played, so leaving and returning to
 *  the thread never replays it. `key` guards against clearing a newer
 *  flash that arrived while the old one's flight was still finishing. */
export function clearAppshotFlash(key: number): void {
  if (flash?.key === key) {
    flash = null
    emit()
  }
}

function playShutter(): void {
  try {
    const audio = new Audio(shutterUrl)
    audio.volume = 0.6
    void audio.play().catch(() => undefined)
  } catch {
    // no audio device
  }
}

export function attachmentFromCapture(capture: AppshotCapture): Attachment {
  return {
    id: capture.path,
    name: capture.name,
    mimeType: capture.mime ?? 'image/jpeg',
    kind: 'image',
    size: 0,
    path: capture.path,
    ...(capture.textPath ? { textPath: capture.textPath } : {}),
    // Captured on this machine: a thread on another host gets it uploaded.
    environmentId: registry.primary().environmentId
  }
}

let chain: Promise<void> = Promise.resolve()

/** Route one capture. Arrivals serialize, so two quick shots never race a new chat. */
export function appshotArrived(capture: AppshotCapture): Promise<void> {
  chain = chain.then(async () => {
    const attachment = attachmentFromCapture(capture)
    const target = await resolveTarget(settings.destination).catch(() => null)
    if (!target) return
    stage(target, attachment)
    flash = { sessionId: target, attachment, key: Date.now() }
    emit()
    if (settings.sound) playShutter()
  })
  return chain
}

const PERMISSION_CODES = new Set(['screen-permission', 'ax-permission'])

/** Mount once at boot: the listener's mount also flushes main's queue. */
export function initAppshots(): () => void {
  void loadAppshotSettings()
  const offCapture = bridge.onCapture((capture) => {
    void appshotArrived(capture)
  })
  const offError = bridge.onError(({ code }) => {
    if (!PERMISSION_CODES.has(code)) return
    void refreshAppshotPermissions()
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: 'appshots' }))
  })
  return () => {
    offCapture()
    offError()
  }
}
