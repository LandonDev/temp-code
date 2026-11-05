import { readFileSync } from 'node:fs'
import { applyProbedCatalog, PROBED_PROVIDERS, type ProviderId } from '@shared/catalog'
import { probeCatalog as probeFx } from './harness/fxCatalog'
import { probeCatalog as probeGrok } from './harness/grokCatalog'
import { probeCatalog as probeMuse } from './harness/museCatalog'
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
  fx: probeFx,
  muse: () => probeMuse()
}

/**
 * Proof seam: `TEMP_CODE_PROBED_CATALOG=<file>` on an isolated instance (one
 * with TEMP_CODE_USER_DATA) answers the providers the file names
 * (`{ "muse": { "models": [...], "defaultModel": "..." } }`) in place of
 * their CLIs, so a two-host proof can give one host rows the other lacks
 * (scripts/e2e-rules-sync.ts).
 */
export function seamedProbes(env: NodeJS.ProcessEnv = process.env): Partial<Record<ProviderId, unknown>> | null {
  const path = env.TEMP_CODE_PROBED_CATALOG
  if (!path || !env.TEMP_CODE_USER_DATA) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<ProviderId, unknown>>
  } catch (err) {
    console.error(`[catalog] TEMP_CODE_PROBED_CATALOG unreadable: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

let inflight: Promise<void> | null = null
let probedOnce = false

export function probeCatalogs(refresh = false): Promise<void> {
  if (inflight) return inflight
  if (probedOnce && !refresh) return Promise.resolve()
  const seam = seamedProbes()
  inflight = Promise.all(
    PROBED_PROVIDERS.map(async (id) => {
      try {
        const probe = seam?.[id] ? async () => seam[id] : PROBES[id]
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
