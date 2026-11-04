import type { ModelInfo, Reasoning } from '@shared/catalog'
import type { ModelCatalogEntry, ModelListResult, ReasoningEffort } from '@muse-code/sdk/dist/src/msp'
import { spawnMuseHost } from './museHost'

/** The shared ladder; Muse's `none` is dropped (Meta's provider rejects it)
 *  and `minimal` until the ladder carries it. */
const LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const onLadder = (tier: ReasoningEffort | string): tier is Reasoning => LADDER.includes(tier)

/** `variants` is the whole ladder; `reasoningEffortVariants` only the
 *  described tiers (spark-1.2 describes xhigh alone of its five), so it is
 *  read only when the ladder is missing. */
function tiersOf(entry: ModelCatalogEntry): ReasoningEffort[] {
  if (Array.isArray(entry.variants) && entry.variants.length) return entry.variants as ReasoningEffort[]
  if (entry.reasoningEffortVariants?.length) return entry.reasoningEffortVariants.map((v) => v.tier)
  return []
}

/** "muse-wonder-full-1.0" → "Muse Wonder Full 1.0": the catalog's labels
 *  are the ids themselves (1.4.14), so the picker gets words. */
export function museLabel(id: string): string {
  return id
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

export function toModelInfo(entry: ModelCatalogEntry): ModelInfo {
  const reasoning = tiersOf(entry).filter(onLadder)
  const defaultReasoning = entry.defaultReasoningEffort && onLadder(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : undefined
  return {
    id: entry.modelId,
    label: entry.displayLabel && entry.displayLabel !== entry.modelId ? entry.displayLabel : museLabel(entry.modelId),
    reasoning,
    ...(defaultReasoning && reasoning.includes(defaultReasoning) ? { defaultReasoning } : {}),
    ...(entry.contextLimit ? { context: entry.contextLimit } : {})
  }
}

/** `model/list` → the catalog's rows, the default from `isDefault`, else
 *  the first row. `isActive` is the session's current pick, not whether a
 *  row can be used (every row read false on a fresh host), so none is
 *  dropped for it. */
export function museModels(result: Pick<ModelListResult, 'models'>): { models: ModelInfo[]; defaultModel: string } {
  const models = result.models.map(toModelInfo)
  const def = result.models.find((m) => m.isDefault)
  return { models, defaultModel: def?.modelId ?? models[0]?.id ?? '' }
}

/** The live catalog of the installed Muse Code, asked of a throwaway host
 *  under the CLI's own login (or `configDir`, an account's dir, since
 *  `model/list` is empty when nobody is signed in). null when the binary is
 *  not installed; a probe failure on an installed binary throws. */
export async function probeCatalog(configDir?: string | null): Promise<{ label: string; models: ModelInfo[]; defaultModel: string } | null> {
  let host
  try {
    host = await spawnMuseHost({ sessionId: 'catalog-probe', cwd: process.cwd(), configDir, args: ['--no-session-log'] })
  } catch (err) {
    if (/not found/i.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  }
  try {
    const result = (await host.connection.request('model/list', {})) as unknown as ModelListResult
    return { label: 'Muse Code', ...museModels(result) }
  } finally {
    await host.close()
  }
}
