import { PROBED_PROVIDERS, type ModelInfo, type ProviderId, type ProviderInfo } from '@shared/catalog'
import type { ProbedRow } from '@shared/rules'
import { ProviderInfoSchema } from '@shared/wireSchemas'

/**
 * What the other hosts can run. The orchestration rules have one copy
 * (remote/rulesSync.ts), but each host serves only the models its own CLIs
 * serve: the box's Muse Code list is empty (Meta answers its address with no
 * catalog) while the Mac's has four rows. Read off the local catalog alone,
 * a box thread saw no approved Muse model in its table and spawn_agent
 * refused one even with `environmentId: "mac"`, so the approvals looked as
 * if they never reached the box.
 *
 * Each host keeps the visible catalog of every host it reaches, as that host
 * last sent it (`catalog.exchange`, both ways on each rules sync), and keeps
 * it on disk so a restart knows it before the link is back:
 *
 *  - the spawn table lists another host's approved rows this host lacks,
 *    under that host (orchestration.ts `spawnableModels`);
 *  - spawn_agent and app_start_thread that name a host check the model
 *    against that host's rows, and one that names none is pointed at the
 *    host that serves it;
 *  - `withProbedDefaults` reads every host's probed rows, so an undecided
 *    Muse model reads the same on both hosts.
 */

export type HostCatalog = Partial<Record<ProviderId, ProviderInfo>>

export const PEER_CATALOG_KEY = 'catalog:peer:'
const INDEX_KEY = 'catalog:peers'

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
}

/** The entries of a sent catalog this build can read; a provider it does not know is left out. */
export function readCatalog(raw: unknown): HostCatalog {
  const out: HostCatalog = {}
  if (!raw || typeof raw !== 'object') return out
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const parsed = ProviderInfoSchema.safeParse(value)
    if (parsed.success) out[parsed.data.id] = parsed.data as ProviderInfo
  }
  return out
}

export class PeerCatalogs {
  private readonly cache = new Map<string, HostCatalog>()
  private loaded = false

  constructor(private readonly store: SettingsStore) {}

  /** A host's catalog as it sent it; true when it changed. */
  set(environmentId: string, sent: unknown): boolean {
    this.load()
    const catalog = readCatalog(sent)
    const raw = JSON.stringify(catalog)
    if (JSON.stringify(this.cache.get(environmentId) ?? null) === raw) return false
    this.cache.set(environmentId, catalog)
    this.store.setSetting(`${PEER_CATALOG_KEY}${environmentId}`, raw)
    this.store.setSetting(INDEX_KEY, JSON.stringify([...this.cache.keys()]))
    return true
  }

  get(environmentId: string): HostCatalog | null {
    this.load()
    return this.cache.get(environmentId) ?? null
  }

  /** A host's row for a model, when that host serves it. */
  modelInfo(environmentId: string, provider: ProviderId, modelId: string): ModelInfo | undefined {
    return this.get(environmentId)?.[provider]?.models.find((m) => m.id === modelId)
  }

  /** Every known host's rows of the probed providers, for `withProbedDefaults`. */
  probedRows(): ProbedRow[] {
    this.load()
    const out: ProbedRow[] = []
    for (const catalog of this.cache.values()) {
      for (const p of PROBED_PROVIDERS) for (const m of catalog[p]?.models ?? []) out.push({ provider: p, id: m.id })
    }
    return out
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    let ids: unknown = []
    try {
      ids = JSON.parse(this.store.getSetting(INDEX_KEY) ?? '[]')
    } catch {
      return
    }
    if (!Array.isArray(ids)) return
    for (const id of ids) {
      if (typeof id !== 'string') continue
      try {
        this.cache.set(id, readCatalog(JSON.parse(this.store.getSetting(`${PEER_CATALOG_KEY}${id}`) ?? 'null')))
      } catch {
        // A row this build cannot read waits for the host's next exchange.
      }
    }
  }
}
