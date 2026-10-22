import { z } from 'zod'

// Admission control (src/main/server/admission.ts): how many harness
// processes run on this host at once. The cap is the pinned setting, else
// sized from memory; threads past it wait `queued` and start oldest first.

export interface AdmissionMemory {
  /** The smaller of the cgroup's memory.high/max and the machine's memory. */
  budgetMB: number
  /** What the cap leaves to everything else. */
  reserveMB: number
  /** The median RSS of the live harness processes (450 until five readings). */
  perProcessMB: number
  /** Available memory now. */
  freeMB: number
  /** Under this much available memory nothing new is admitted (10% of the budget). */
  floorMB: number
}

export interface AdmissionState {
  /** The cap in force: the pinned one, else the default. */
  cap: number
  /** The `admission.maxRunning` setting; null runs on the default. */
  pinned: number | null
  default: number
  /** Live harness processes, roots and subagents, plus starts reserved. */
  running: number
  queued: number
  memory: AdmissionMemory
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const AdmissionRequestSchemas = [
  /** → AdmissionState */
  z.object({ id: z.string(), method: z.literal('admission.get'), params: z.object({}).optional() }),
  /** → AdmissionState: pin the cap, or null for the default. */
  request('admission.set', z.object({ cap: z.number().int().min(1).max(10_000).nullable() }))
] as const
