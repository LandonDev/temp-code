import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface UpdateStatus {
  current: number
  latest: number | null
  notes: string
  canApply: boolean
  phase: 'idle' | 'checking' | 'building' | 'restarting' | 'error'
  error?: string
}

const api = {
  getServerPort: (): Promise<number | null> => ipcRenderer.invoke('server-port'),
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
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
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
