/**
 * The renderer soak's synthetic host as a process (scripts/lib/soakHost.ts):
 * one JSON line with the address, the seeded ids and an operate key, then
 * the load until SIGTERM, SIGINT or stdin closes. scripts/measure-renderer-soak.ts
 * starts it under bun with the electron stub on Linux, and on macOS bundled
 * by esbuild under node (the Mac's bun has no node:sqlite), as
 * scripts/ios-client-test.ts runs its server.
 */
import { createInterface } from 'node:readline'
import { startSoakHost } from './lib/soakHost'
import type { SoakDriver } from './lib/soakLoad'

// `--scene chat`: one plain chat thread instead of the master's batch;
// `--scene typing`: the batch with the master's own churn and its live edits;
// `--scene switch`: the batch and a second workspace to switch to;
// `--burst <ms>`: its deltas leave in bursts (soakLoad.ts BurstCadence).
// `--scene scenarios`: one quiet chat that plays the no-jerk timeline when a
// line "go" arrives on stdin, writing `{"step": label, "at": ms, "clicks"?}` per
// step (the clicks are the soak's to perform in the window).
// A line "pause" or "resume" holds or restarts every stream of the load,
// answered `{"paused": true}` or `{"resumed": true}` once it holds.
const argAfter = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const named = argAfter('--scene')
const host = await startSoakHost(named === 'chat' || named === 'typing' || named === 'switch' || named === 'scenarios' ? named : 'board')
const started = Date.now()
let driver: SoakDriver | null = null
if (host.scene !== 'scenarios') {
  const burstMs = Number(argAfter('--burst') ?? 0)
  driver = host.startLoad(undefined, burstMs > 0 ? { everyMs: burstMs } : null)
}
// JSON drops the two functions; the rest is the line the soak reads.
process.stdout.write(JSON.stringify({ ready: true, ...host }) + '\n')
const answer = (line: object): boolean => process.stdout.write(JSON.stringify(line) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = line.trim()
  if (command === 'go' && host.scene === 'scenarios') {
    host.playScenarios((step) => answer({ step: step.label, at: Date.now() - started, clicks: step.clicks }))
  } else if (command === 'pause' && driver) {
    driver.pause()
    answer({ paused: true })
  } else if (command === 'resume' && driver) {
    driver.resume()
    answer({ resumed: true })
  }
})
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
