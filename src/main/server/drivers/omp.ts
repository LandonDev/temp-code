import type { HarnessDriver } from './types'
import { createPiDriver } from './harness/piDriver'
import { OMP_FLAVOR } from './harness/piFlavor'

/**
 * omp (oh-my-pi) driver. A fork of Pi speaking the same RPC protocol, so
 * it runs on the pi family engine with omp's renamed flags (piFlavor.ts).
 */
export const ompDriver: HarnessDriver = createPiDriver(OMP_FLAVOR)
