import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Instance overrides for an isolated copy of the app: its own userData, a
 * CDP port, and an update feed of its own. Dev instances pass them through
 * the environment (CLAUDE.md). A packaged test build carries the same keys
 * inside its own package.json under `tempcodeHarness` (electron-builder's
 * extraMetadata, written by scripts/e2e-updater.ts): the updater's ShipIt
 * relaunches an installed bundle with a clean environment, and without the
 * baked block a relaunched test app would come up as a plain packaged app on
 * the real userData. The environment wins over the block; a build without
 * the block has nothing to apply.
 */
export const HARNESS_KEYS = [
  'TEMP_CODE_USER_DATA',
  'TEMP_CODE_DEBUG_PORT',
  'TEMP_CODE_UPDATE_FEED',
  /** 'yes' or 'no': what every ask dialog answers, so a driver can get past
   *  the quit-while-busy question. Honored only with an isolated userData. */
  'TEMP_CODE_DIALOG_ANSWER'
] as const

export type HarnessKey = (typeof HARNESS_KEYS)[number]
export type Harness = Partial<Record<HarnessKey, string>>

/** The `tempcodeHarness` block of a package.json; unknown keys are dropped.
 *  Numbers count (electron-builder coerces "9230" on the command line). */
export function pickHarness(raw: unknown): Harness {
  if (!raw || typeof raw !== 'object') return {}
  const out: Harness = {}
  for (const key of HARNESS_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
    if (text) out[key] = text
  }
  return out
}

export function bakedHarness(appPath: string): Harness {
  try {
    const pkg = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as {
      tempcodeHarness?: unknown
    }
    return pickHarness(pkg.tempcodeHarness)
  } catch {
    return {}
  }
}

/** Fill in every key the environment left unset. */
export function applyHarness(env: NodeJS.ProcessEnv, baked: Harness): void {
  for (const key of HARNESS_KEYS) {
    if (!env[key] && baked[key]) env[key] = baked[key]
  }
}
