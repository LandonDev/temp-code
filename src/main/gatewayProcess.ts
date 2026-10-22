import { net } from 'electron'
import { runGatewayChild } from './server/gatewayChild'
import { portWire, type PortLike } from './server/gatewayWire'

/**
 * Entry of the gateway's utility process (gatewaySpawn.ts forks it): main
 * transfers one MessagePortMain, and the gateway serves over it until main
 * is gone (gatewayChild.ts).
 */
process.parentPort.once('message', (e) => {
  const [port] = e.ports
  if (!port) process.exit(1)
  runGatewayChild(portWire(port as unknown as PortLike), { chromiumFetch: (input, init) => net.fetch(input, init) })
})
