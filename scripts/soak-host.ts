/**
 * The renderer soak's synthetic host as a process (scripts/lib/soakHost.ts):
 * one JSON line with the address, the seeded ids and an operate key, then
 * the load until SIGTERM, SIGINT or stdin closes. scripts/measure-renderer-soak.ts
 * starts it under bun with the electron stub on Linux, and on macOS bundled
 * by esbuild under node (the Mac's bun has no node:sqlite), as
 * scripts/ios-client-test.ts runs its server.
 */
import { startSoakHost } from './lib/soakHost'

const host = await startSoakHost()
host.startLoad()
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
