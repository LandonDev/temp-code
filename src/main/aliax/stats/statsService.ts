import { app } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ALIAX_DATA_DIR } from '../../aliax'
import { defaultRoots } from './indexer'
import { StatsHost } from './statsHost'
import type { StatsWorkerData } from './statsWire'

/** The app's one stats host, started on first use over out/main/statsWorker.js
 *  beside this bundle (electron.vite.config.ts), the database under userData. */
let host: StatsHost | null = null
export function statsHost(): StatsHost {
  return (host ??= new StatsHost({
    spawn: () => {
      const workerData: StatsWorkerData = { dbPath: join(app.getPath('userData'), 'stats.db'), seedDir: ALIAX_DATA_DIR, roots: defaultRoots() }
      return new Worker(join(__dirname, 'statsWorker.js'), { workerData })
    }
  }))
}
