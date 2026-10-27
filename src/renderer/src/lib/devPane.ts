import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { clampDockSize, DOCK_SIZE_DEFAULT } from './projectTerminal'

/**
 * The Dev servers pane (docs/box.md "Dev servers on the box"): one pane in
 * the bottom dock, in place of the terminal dock while it is open. Closed
 * until the person opens it, and it remembers open and its height across
 * launches the way the terminal dock does. Nothing ever opens it on its own.
 */

const KEY = 'monocode.devPane'

export interface DevPaneState {
  open: boolean
  size: number
  /** The row picked in the list; a row the host dropped falls back to the newest (`shownServer`). */
  picked: string | null
}

function load(): DevPaneState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (raw && typeof raw === 'object') {
      const { open, size } = raw as { open?: unknown; size?: unknown }
      return { open: open === true, size: typeof size === 'number' ? clampDockSize(size) : DOCK_SIZE_DEFAULT, picked: null }
    }
  } catch {
    /* no storage, or not JSON */
  }
  return { open: false, size: DOCK_SIZE_DEFAULT, picked: null }
}

export const devPaneStore = createStore<DevPaneState>(load)

devPaneStore.subscribe((s, prev) => {
  if (s.open === prev.open && s.size === prev.size) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ open: s.open, size: s.size }))
  } catch {
    /* storage full or off: this window still remembers */
  }
})

export const devPane = {
  /** Open the pane, showing `key` when given. */
  open: (key?: string) => devPaneStore.setState((s) => ({ open: true, picked: key ?? s.picked })),
  close: () => devPaneStore.setState({ open: false }),
  toggle: () => devPaneStore.setState((s) => ({ open: !s.open })),
  pick: (key: string) => devPaneStore.setState({ picked: key }),
  size: (size: number) =>
    devPaneStore.setState({ size: clampDockSize(size, typeof window === 'undefined' ? undefined : { width: window.innerWidth, height: window.innerHeight }) })
}

export function useDevPane<T>(selector: (s: DevPaneState) => T): T {
  return useStore(devPaneStore, selector)
}

/** Tests start from a fresh load of storage. */
export function resetDevPane(): void {
  devPaneStore.setState(load(), true)
}
