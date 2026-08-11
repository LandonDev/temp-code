import { ElectronAPI } from '@electron-toolkit/preload'
import type { TempCodeApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: TempCodeApi
  }
}
