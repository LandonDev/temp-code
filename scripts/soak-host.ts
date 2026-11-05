/**
 * The renderer soak's synthetic host as a process (scripts/lib/soakHost.ts):
 * one JSON line with the address, the seeded ids and an operate key, then
 * the load until SIGTERM, SIGINT or stdin closes. scripts/measure-renderer-soak.ts
 * starts it under bun with the electron stub on Linux, and on macOS bundled
 * by esbuild under node (the Mac's bun has no node:sqlite), as
 * scripts/ios-client-test.ts runs its server.
 */
import { startSoakHost } from './lib/soakHost'

// `--scene chat`: one plain chat thread instead of the master's batch;
// `--burst <ms>`: its deltas leave in bursts (soakLoad.ts BurstCadence).
const argAfter = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const host = await startSoakHost(argAfter('--scene') === 'chat' ? 'chat' : 'board')
const burstMs = Number(argAfter('--burst') ?? 0)
host.startLoad(undefined, burstMs > 0 ? { everyMs: burstMs } : null)
// JSON drops the two functions; the rest is the line the soak reads.
process.stdout.write(JSON.stringify({ ready: true, ...host }) + '\n')
let closing = false
const quit = (): void => {
  if (closing) return
  closing = true
  void host.close().finally(() => process.exit(0))
}
process.on('SIGTERM', quit)
process.on('SIGINT', quit)
process.stdin.on('end', quit)
process.stdin.resume()
