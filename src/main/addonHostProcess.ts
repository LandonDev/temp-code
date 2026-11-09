import { runAddonChild } from './server/addons/addonChild'
import type { AddonWireMessage } from './server/addons/addonWire'
import { portWire, type PortLike } from './server/gatewayWire'

/**
 * Entry of the add-on host's utility process (addonHostSpawn.ts forks it):
 * main transfers one MessagePortMain, and the downstream MCP clients serve
 * over it until main is gone (addons/addonChild.ts). An error nothing
 * caught is logged redacted; it fails the add-on it names, else ends the
 * process and main respawns it.
 */
process.parentPort.once('message', (e) => {
  const [port] = e.ports
  if (!port) process.exit(1)
  const child = runAddonChild(portWire<AddonWireMessage>(port as unknown as PortLike))
  process.on('uncaughtException', (error) => child.uncaught(error))
  process.on('unhandledRejection', (error) => child.uncaught(error))
})
