import { useState } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import type {
  MacBridgeRule,
  MacDecideRemember,
  MacRemember
} from '@server/shared/contract-macbridge-rules'
import type { EnvLink } from './connection/link'
import { LOCAL_ENVIRONMENT_ID, registry } from './connection/registry'
import { isWebMode } from './nativeWeb'
import { quoteArgv } from './macBridge'

/**
 * The Mac bridge's remembered approvals in the renderer (docs/box.md "The
 * Mac bridge", "Remembered approvals"). They live in this Mac's main
 * process memory; `macBridge.rules.list` / `.forget` (local) read and drop
 * them for the thread's "Mac approvals" dialog and Settings → Remote access.
 * A thread removed on its host takes its rules with it: every remote link's
 * `session-removed` (and a move off the host) forgets them here.
 */

type State = { rules: MacBridgeRule[]; loaded: boolean }
const store = createStore<State>(() => ({ rules: [], loaded: false }))
export const macBridgeRulesStore = store

const local = () => registry.link(LOCAL_ENVIRONMENT_ID)

/** Re-read every rule this Mac holds. */
export async function loadMacBridgeRules(): Promise<MacBridgeRule[]> {
  const link = local()
  if (!link?.connected) return store.getState().rules
  try {
    const rules = await link.request<MacBridgeRule[]>('macBridge.rules.list', {})
    store.setState({ rules, loaded: true })
    return rules
  } catch {
    return store.getState().rules // an older server without the methods
  }
}

/** Forget one of a thread's rules, or all of them. */
export async function forgetMacBridgeRules(sessionId: string, ruleId?: string): Promise<void> {
  const link = local()
  if (!link) throw new Error('not connected')
  const left = await link.request<MacBridgeRule[]>('macBridge.rules.forget', {
    sessionId,
    ...(ruleId ? { ruleId } : {})
  })
  store.setState((s) => ({
    rules: [...s.rules.filter((r) => r.sessionId !== sessionId), ...left]
  }))
}

export function useMacBridgeRules(sessionId?: string): MacBridgeRule[] {
  const rules = useStore(store, (s) => s.rules)
  return sessionId ? rules.filter((r) => r.sessionId === sessionId) : rules
}

let started = false
/** Forget a thread's rules when its host removes it or it moves away; idempotent, desktop only. */
export function startMacBridgeRules(): void {
  if (started || isWebMode()) return
  started = true
  const watch = (link: EnvLink) => {
    if (link.environmentId === LOCAL_ENVIRONMENT_ID) return
    link.onPush((push) => {
      const ended =
        push.push === 'session-removed'
          ? push.sessionIds
          : push.push === 'session-moved'
            ? push.sessionIds
            : null
      if (!ended?.length) return
      const known = new Set(store.getState().rules.map((r) => r.sessionId))
      for (const id of ended)
        if (known.has(id)) void forgetMacBridgeRules(id).catch(() => undefined)
    })
  }
  for (const link of registry.links()) watch(link)
  registry.onLink((link, event) => {
    if (event === 'added') watch(link)
  })
}

/** The choice on a run card: one of the kinds, or nothing remembered. */
export type RunRememberChoice = MacRemember | 'ask'

/** What a run card offers, in order; exact first (the default). */
export function runRememberOptions(
  request: MacBridgeRequest
): { value: RunRememberChoice; label: string }[] {
  if (request.alwaysAsk) return []
  return [
    { value: 'exact', label: 'Allow this exact command for this thread' },
    ...(request.folder
      ? [{ value: 'folder' as const, label: `Any command in ${request.folder}` }]
      : []),
    ...(request.program
      ? [{ value: 'program' as const, label: `Any ${request.program} command, any folder` }]
      : []),
    { value: 'thread', label: 'Every command from this thread' },
    { value: 'ask', label: 'Ask every time' }
  ]
}

/** One rule, as the lists show it. */
export function ruleText(rule: MacBridgeRule): { what: string; detail: string } {
  switch (rule.kind) {
    case 'read-folder':
      return { what: 'Reads in', detail: rule.folder ?? '' }
    case 'folder':
      return { what: 'Commands in', detail: rule.folder ?? '' }
    case 'program':
      return { what: 'Any command running', detail: rule.program ?? '' }
    case 'thread':
      return { what: 'Every command', detail: 'from this thread' }
    case 'exact':
      return {
        what: 'Exactly',
        detail: `${rule.argv ? quoteArgv(rule.argv) : (rule.command ?? '')}  (in ${rule.cwd ?? ''})`
      }
  }
}

/** A run card's remember choice: exact by default; an always-ask command offers none. */
export function useRunRemember(request: MacBridgeRequest): {
  choice: RunRememberChoice
  setChoice: (c: RunRememberChoice) => void
  remember: MacDecideRemember
} {
  const [choice, setChoice] = useState<RunRememberChoice>('exact')
  const offered = runRememberOptions(request).length > 0
  return {
    choice,
    setChoice,
    remember: !offered || choice === 'ask' ? false : choice
  }
}
