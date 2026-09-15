import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
// Mirrors the main-process asset URL builder so the renderer can turn a
// logo path into a URL without a round trip.
import { logoAssetUrl } from '../shared/assets'

type DialogKind = 'info' | 'warning' | 'error'

interface OpenOptions {
  title?: string
  defaultPath?: string
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
}

interface AskOptions {
  title?: string
  kind?: DialogKind
  okLabel?: string
  cancelLabel?: string
}

interface MessageOptions {
  title?: string
  kind?: DialogKind
}

interface PtySpawnArgs {
  id: string
  cwd: string
  cols: number
  rows: number
}

/** Subscribes to an IPC channel and hands back the unsubscribe. */
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

interface UpdateStatus {
  current: number
  latest: number | null
  notes: string
  canApply: boolean
  phase: 'idle' | 'checking' | 'building' | 'restarting' | 'error'
  step?: string
  detail?: string
  stepStartedAt?: number
  stepEtaMs?: number
  error?: string
}

interface AppshotAttachment {
  path: string
  name: string
  mime?: string
  kind: 'appshot'
  textPath?: string
}

interface AppshotPermissions {
  available: boolean
  screen: boolean
  ax: boolean
}

const api = {
  getServerPort: (): Promise<number | null> => ipcRenderer.invoke('server-port'),
  appshots: {
    /** Mounts the capture listener and flushes any queued captures. */
    onCapture: (cb: (a: AppshotAttachment) => void): (() => void) => {
      const listener = (_e: unknown, a: AppshotAttachment): void => cb(a)
      ipcRenderer.on('appshot', listener)
      ipcRenderer.send('appshot-ready')
      return () => ipcRenderer.removeListener('appshot', listener)
    },
    onError: (cb: (e: { code: string }) => void): (() => void) => {
      const listener = (_e: unknown, err: { code: string }): void => cb(err)
      ipcRenderer.on('appshot-error', listener)
      return () => ipcRenderer.removeListener('appshot-error', listener)
    },
    permissions: (prompt?: boolean): Promise<AppshotPermissions> =>
      ipcRenderer.invoke('appshot-permissions', prompt)
  },
  updates: {
    get: (): Promise<UpdateStatus> => ipcRenderer.invoke('update-get'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update-check'),
    apply: (): Promise<UpdateStatus> => ipcRenderer.invoke('update-apply'),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const listener = (_e: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on('update-status', listener)
      return () => ipcRenderer.removeListener('update-status', listener)
    }
  },
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('pick-directory', defaultPath),
  revealInFinder: (path: string): Promise<void> => ipcRenderer.invoke('reveal-in-finder', path),
  /** Real disk path of a dropped File (File.path is gone in Electron ≥32). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  pty: {
    /** Resolves to the requested directory when it was missing and the
     *  shell fell back to $HOME, else null. */
    spawn: (args: PtySpawnArgs): Promise<string | null> => ipcRenderer.invoke('pty-spawn', args),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke('pty-write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('pty-resize', id, cols, rows),
    status: (id: string): Promise<{ foreground: string | null }> =>
      ipcRenderer.invoke('pty-status', id),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('pty-kill', id),
    killAll: (): Promise<void> => ipcRenderer.invoke('pty-kill-all'),
    /** Pay back the bytes xterm has written, so main can unpause the shell. */
    ack: (id: string, bytes: number): void => ipcRenderer.send('pty-ack', id, bytes),
    onData: (cb: (id: string, data: Uint8Array) => void): (() => void) =>
      on<[string, Uint8Array]>('pty-data', (id, data) => cb(id, new Uint8Array(data))),
    onExit: (cb: (id: string, code: number | null) => void): (() => void) =>
      on<[string, number | null]>('pty-exit', cb)
  },

  win: {
    /** This window's slot: names its bounds and its workspace snapshot. */
    slot: process.argv.find((a) => a.startsWith('--tc-window-slot='))?.slice(17) ?? 'main',
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    isFocused: (): Promise<boolean> => ipcRenderer.invoke('window:is-focused'),
    setTitle: (title: string): Promise<void> => ipcRenderer.invoke('window:set-title', title),
    hide: (): Promise<void> => ipcRenderer.invoke('window:hide'),
    destroy: (): Promise<void> => ipcRenderer.invoke('window:destroy'),
    create: (): Promise<void> => ipcRenderer.invoke('window:new'),
    stageTransfer: (payload: unknown): Promise<void> =>
      ipcRenderer.invoke('window:stage-transfer', payload),
    takeTransfer: <T>(): Promise<T | null> => ipcRenderer.invoke('window:take-transfer'),
    setButtonsVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke('window:buttons-visible', visible),
    enableGlass: (): Promise<void> => ipcRenderer.invoke('window:enable-glass'),
    disableGlass: (color?: string): Promise<void> =>
      ipcRenderer.invoke('window:disable-glass', color),
    setGlassPref: (on: boolean): Promise<void> => ipcRenderer.invoke('window:set-glass-pref', on),
    setZoom: (factor: number): Promise<void> => ipcRenderer.invoke('window:set-zoom', factor),
    onResized: (cb: () => void): (() => void) => on('window:resized', cb),
    /** Subscribing makes main defer the close to you: answer with hide() or
     *  destroy(). Without a subscriber the window closes by itself. */
    onCloseRequested: (cb: () => void): (() => void) => {
      ipcRenderer.send('window:close-subscribe')
      return on('window:close-requested', cb)
    },
    /** Quit was confirmed in another window; write your snapshot now and
     *  call persisted() so the exit can go on. */
    onPersistRequested: (cb: () => void): (() => void) => on('window:persist-requested', cb),
    persisted: (): void => ipcRenderer.send('window:persisted')
  },

  menu: {
    onCommand: (cb: (id: string) => void): (() => void) =>
      on<[string]>('native:menu', (id) => cb(id))
  },

  dialog: {
    open: (options?: OpenOptions): Promise<string | string[] | null> =>
      ipcRenderer.invoke('dialog:open', options ?? {}),
    ask: (text: string, options?: AskOptions): Promise<boolean> =>
      ipcRenderer.invoke('dialog:ask', text, options ?? {}),
    message: (text: string, options?: MessageOptions): Promise<void> =>
      ipcRenderer.invoke('dialog:message', text, options ?? {})
  },

  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    homeDir: (): Promise<string> => ipcRenderer.invoke('app:home-dir'),
    defaultCwd: (): Promise<string> => ipcRenderer.invoke('app:default-cwd'),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-url', url),
    dockBadge: (count: number): Promise<void> => ipcRenderer.invoke('app:dock-badge', count),
    confirmQuit: (): Promise<void> => ipcRenderer.invoke('app:confirm-quit'),
    /** Subscribing makes main ask you before it exits. */
    onQuitRequested: (cb: () => void): (() => void) => {
      ipcRenderer.send('app:quit-subscribe')
      return on('app:quit-requested', cb)
    },
    logoUrl: (absolutePath: string): string => logoAssetUrl(absolutePath)
  },

  /** Dev builds only; the handlers are not registered in a packaged app. */
  debug: {
    menuClick: (id: string): Promise<boolean> => ipcRenderer.invoke('debug:menu-click', id),
    dockBadge: (): Promise<string | null> => ipcRenderer.invoke('debug:dock-badge'),
    windowTitle: (): Promise<string | undefined> => ipcRenderer.invoke('debug:window-title'),
    ptyFlow: (): Promise<{ pauses: number; resumes: number }> =>
      ipcRenderer.invoke('debug:pty-flow'),
    nextPick: (paths: string[]): Promise<void> => ipcRenderer.invoke('debug:next-pick', paths),
    assetFetch: (url: string): Promise<{ status: number; body: string }> =>
      ipcRenderer.invoke('debug:asset-fetch', url),
    windows: (): Promise<unknown[]> => ipcRenderer.invoke('debug:windows'),
    ptys: (): Promise<unknown[]> => ipcRenderer.invoke('debug:ptys'),
    appshot: (): Promise<number | null> => ipcRenderer.invoke('debug:appshot')
  }
}

export type TempCodeApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
