import { MessageChannelMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import type { GatewayChildLink } from './server/gateway'
import { portWire } from './server/gatewayWire'

/**
 * The gateway's utility process (out/main/gateway.js, built from
 * gatewayProcess.ts beside index.js and boot.js): its own process and heap,
 * Chromium's `net` for chatgpt.com, and a MessagePortMain to main. Electron
 * ends it with the app; the child also exits when the port closes or main's
 * pid is gone (gatewayChild.ts).
 */
export function spawnGatewayChild(): GatewayChildLink {
  const child = utilityProcess.fork(join(__dirname, 'gateway.js'), [], { serviceName: 'TempCode Gateway', stdio: 'inherit' })
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ t: 'port' }, [port2])
  return {
    wire: portWire(port1),
    kill: () => void child.kill(),
    onExit: (fn) => void child.once('exit', (code) => fn(code))
  }
}
