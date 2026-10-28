import { parentPort, workerData } from 'node:worker_threads'
import { StatsEngine } from './statsEngine'
import type { StatsReply, StatsRequest, StatsWorkerData } from './statsWire'

/**
 * Entry of the stats worker (out/main/statsWorker.js, a main entry beside
 * gateway.js; statsHost.ts starts it as a worker thread): one StatsEngine
 * over the app's stats.db, serving main's requests over parentPort. The
 * index and the bundle's SQL run here, never on the host's loop.
 */
const port = parentPort
if (!port) throw new Error('statsWorker: no parent port')
const post = (reply: StatsReply): void => port.postMessage(reply)

let engine: StatsEngine
try {
  const data = workerData as StatsWorkerData
  engine = new StatsEngine({ ...data, onProgress: (progress) => post({ type: 'progress', progress }) })
  post({ type: 'ready' })
} catch (error) {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  throw error
}

port.on('message', (request: StatsRequest) => {
  void (async () => {
    try {
      switch (request.type) {
        case 'index':
        case 'reindex':
          post({ type: 'index', id: request.id, progress: await engine.index() })
          return
        case 'bundle':
          post({ type: 'bundle', id: request.id, bundle: engine.bundle() })
          return
        case 'sample':
          engine.sample(request.service, request.account, request.label, request.usedPercent, request.resetsAt, request.periodMs)
          return
        case 'appEvent':
          engine.appEvent(request.kind, request.service, request.account, request.detail)
          return
      }
    } catch (error) {
      post({ type: 'error', id: 'id' in request ? request.id : undefined, message: error instanceof Error ? error.message : String(error) })
    }
  })()
})
