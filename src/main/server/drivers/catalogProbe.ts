import { applyProbedCatalog, PROBED_PROVIDERS, type ProviderId } from '@shared/catalog'
import { probeCatalog as probeFx } from './harness/fxCatalog'
import { probeCatalog as probeGrok } from './harness/grokCatalog'
import { probeCatalog as probeOpenCode } from './harness/opencodeCatalog'
import { probeCatalog as probePi } from './harness/piCatalog'

/**
 * The five ported harnesses have no static model list: each driver asks
 * its CLI. Probed once per boot (in the background) and again on
 * `catalog.get {refresh: true}`; a provider that is not installed keeps
 * an empty list.
 */
const PROBES: Partial<Record<ProviderId, () => Promise<unknown>>> = {
  grok: probeGrok,
  opencode: probeOpenCode,
  pi: () => probePi('pi'),
  omp: () => probePi('omp'),
  fx: probeFx
}

let inflight: Promise<void> | null = null
let probedOnce = false

export function probeCatalogs(refresh = false): Promise<void> {
  if (inflight) return inflight
  if (probedOnce && !refresh) return Promise.resolve()
  inflight = Promise.all(
    PROBED_PROVIDERS.map(async (id) => {
      try {
        const probe = PROBES[id]
        if (!probe) return
        const probed = (await probe()) as Parameters<typeof applyProbedCatalog>[1]
        applyProbedCatalog(id as ProviderId, probed)
      } catch (err) {
        console.error(`[catalog] ${id} probe failed:`, err instanceof Error ? err.message : err)
      }
    })
  )
    .then(() => undefined)
    .finally(() => {
      probedOnce = true
      inflight = null
    })
  return inflight
}
