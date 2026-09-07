import type { ProviderId } from '@shared/catalog'
import type { HarnessDriver } from './types'
import { claudeDriver } from './claude'
import { codexDriver } from './codex'
import { cursorDriver } from './cursor'
import { fxDriver } from './fx'
import { grokDriver } from './grok'
import { ompDriver } from './omp'
import { opencodeDriver } from './opencode'
import { piDriver } from './pi'

export const BUILT_IN_DRIVERS: Record<ProviderId, HarnessDriver> = {
  claude: claudeDriver,
  codex: codexDriver,
  cursor: cursorDriver,
  grok: grokDriver,
  opencode: opencodeDriver,
  pi: piDriver,
  omp: ompDriver,
  fx: fxDriver
}
