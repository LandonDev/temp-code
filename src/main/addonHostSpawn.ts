import { MessageChannelMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import type { AddonHostLink, AddonWireMessage } from './server/addons/addonWire'
import { portWire } from './server/gatewayWire'

/**
 * The add-on host's utility process (out/main/addonHost.js, built from
 * addonHostProcess.ts beside gateway.js): every downstream MCP client in a
 * process of its own, so an add-on's fault never reaches a thread's
 * provider stream or the main loop. Electron ends it with the app; the
 * child also exits when the port closes or main's pid is gone.
 */
export function spawnAddonHostChild(): AddonHostLink {
  const child = utilityProcess.fork(join(__dirname, 'addonHost.js'), [], { serviceName: 'TempCode Add-ons', stdio: 'inherit' })
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ t: 'port' }, [port2])
  return {
    wire: portWire<AddonWireMessage>(port1),
    kill: () => void child.kill(),
    onExit: (fn) => void child.once('exit', (code) => fn(code))
  }
}
