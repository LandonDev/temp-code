import type { StatsBundle } from '@shared/aliaxStats'
import type { IndexProgress, IndexRoots } from './indexer'

/** What the stats worker is started with (workerData). */
export interface StatsWorkerData {
  dbPath: string
  seedDir?: string | null
  roots: IndexRoots
}

/** Main → the worker. An `id` names the answer a request waits for. */
export type StatsRequest =
  | { type: 'index'; id: number }
  | { type: 'reindex'; id: number }
  | { type: 'bundle'; id: number }
  | { type: 'sample'; service: string; account: string; label: string; usedPercent: number; resetsAt?: number; periodMs?: number }
  | { type: 'appEvent'; kind: string; service?: string; account?: string; detail?: string }

/** The worker → main. */
export type StatsReply =
  | { type: 'ready' }
  | { type: 'progress'; progress: IndexProgress }
  | { type: 'index'; id: number; progress: IndexProgress }
  | { type: 'bundle'; id: number; bundle: StatsBundle }
  | { type: 'error'; id?: number; message: string }
