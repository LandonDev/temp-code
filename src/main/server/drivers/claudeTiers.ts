import { CATALOG } from '@shared/catalog'

/**
 * Which claude models serve fast mode, as the installed CLI says: the Agent
 * SDK's `query.supportedModels()` marks each row `supportsFastMode`. Asked
 * once per boot, on the first claude session whose query initializes
 * (`noteClaudeInit`), cached in the settings table and applied at boot
 * before the first `catalog.get`. A row the CLI never marked carries no
 * tiers: unknown is never shown as present. `catalog.get {refresh}` clears
 * the flag so the next init asks again.
 */

const KEY = 'claude.speedTiers'

type SettingsStore = {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
}

/** The part of the SDK's ModelInfo this reads. */
export type SupportedModel = { value: string; resolvedModel?: string; supportsFastMode?: boolean }

/** Pure: `{model → ['fast']}` for every row that supports fast mode. The id
 *  is the canonical one (`resolvedModel`, else `value`) without a `[1m]`. */
export function tiersFromSupportedModels(models: readonly SupportedModel[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const m of models) {
    if (!m.supportsFastMode) continue
    const id = (m.resolvedModel ?? m.value).replace(/\[[^\]]*\]$/, '')
    if (id) out[id] = ['fast']
  }
  return out
}

/** Pure: stamp `speedTiers` on the claude rows listed; every other row loses it. */
export function applyClaudeTiers(tiers: Record<string, string[]>): void {
  for (const model of CATALOG.claude.models) {
    const listed = tiers[model.id]
    if (listed?.length) model.speedTiers = listed
    else delete model.speedTiers
  }
}

/** Pure: whether a claude turn asks for fast mode: the thread wants it and
 *  the catalog lists the tier for its model. */
export function claudeFastFor(session: { fast?: boolean }, model: string): boolean {
  if (!session.fast) return false
  return CATALOG.claude.models.find((m) => m.id === model)?.speedTiers?.includes('fast') ?? false
}

export function readClaudeTierCache(store: SettingsStore): Record<string, string[]> | null {
  try {
    const raw = store.getSetting(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : null
  } catch {
    return null
  }
}

let settings: SettingsStore | null = null
let asked = false
let failedOnce = false

/** Boot: apply the cached answer and remember where to keep the next one. */
export function startClaudeTiers(store: SettingsStore): void {
  settings = store
  const cached = readClaudeTierCache(store)
  if (cached) applyClaudeTiers(cached)
}

/** `catalog.get {refresh}`: the next claude init asks again. */
export function forgetClaudeTiers(): void {
  asked = false
}

/** Called when a claude query initializes; asks the CLI once per boot. */
export function noteClaudeInit(q: { supportedModels(): Promise<readonly SupportedModel[]> }): void {
  if (asked || !settings) return
  asked = true
  const store = settings
  void q
    .supportedModels()
    .then((models) => {
      const tiers = tiersFromSupportedModels(models)
      store.setSetting(KEY, JSON.stringify(tiers))
      applyClaudeTiers(tiers)
    })
    .catch((err) => {
      asked = false
      if (failedOnce) return
      failedOnce = true
      console.error('[catalog] claude tiers probe failed:', err instanceof Error ? err.message : err)
    })
}
