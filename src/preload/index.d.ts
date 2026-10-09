import { ElectronAPI } from '@electron-toolkit/preload'
import type { TempCodeApi } from './index'
import type { AliaxApi } from './aliax'

declare global {
  interface Window {
    electron: ElectronAPI
    api: TempCodeApi
    /** The Aliax pages' bridge (see src/preload/aliax.ts). */
    aliax: AliaxApi
  }
}
