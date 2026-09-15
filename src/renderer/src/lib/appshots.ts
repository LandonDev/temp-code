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
import { client } from './tcserver/client'
import { projectForCwd } from './tcserver/projects'
import { sessionStore } from './tcserver/store'
import type { SessionMeta } from './tcserver/types'
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

/** Optimistic: the page flips at once, the server row follows. */
export function setAppshotSettings(patch: Partial<AppshotSettings>): void {
  settings = { ...settings, ...patch }
  emit()
  void client.request('appshots.set', { settings }).catch(() => undefined)
}

async function loadSettings(): Promise<void> {
  try {
    settings = await client.request<AppshotSettings>('appshots.get', {})
    emit()
  } catch {
    // The server fills in defaults; the page shows them until it answers.
  }
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
  const meta = await client.request<SessionMeta>('session.create', {
    threadType: 'chat',
    agentType: 'implementer',
    ...(project ? { projectId: project.id } : { cwd: selected })
  })
  // The push opens the thread behind the user's work; the drop is an
  // explicit ask, so it comes forward too.
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
    ...(capture.textPath ? { textPath: capture.textPath } : {})
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
  void loadSettings()
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
