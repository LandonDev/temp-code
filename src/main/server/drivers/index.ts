import type { ProviderId } from '@shared/catalog'
import type { HarnessDriver } from './types'
import { claudeDriver } from './claude'
import { codexDriver } from './codex'
import { cursorDriver } from './cursor'

export const BUILT_IN_DRIVERS: Record<ProviderId, HarnessDriver> = {
  claude: claudeDriver,
  codex: codexDriver,
  cursor: cursorDriver
}
