import type { HarnessDriver } from './types'
import { createPiDriver } from './harness/piDriver'
import { PI_FLAVOR } from './harness/piFlavor'

/**
 * Pi driver: `pi --mode rpc` with the user's config and extensions loaded
 * (no `--no-extensions`), so packages in `~/.pi/agent` keep working.
 * Everything lives in harness/piDriver.ts + piFamily.ts; omp.ts is the
 * same engine under its flavor.
 */
export const piDriver: HarnessDriver = createPiDriver(PI_FLAVOR)
