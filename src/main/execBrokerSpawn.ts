import { MessageChannelMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import type { ExecBrokerLink } from './server/execBroker'
import { brokerPort } from './server/execBrokerWire'

/**
 * The exec broker's utility process (out/main/execBroker.js, built from
 * execBrokerProcess.ts beside gateway.js): its own small process, so every
 * helper child the server runs (git, gh, ps, ss, lsof) forks from it and
 * never from main. Electron ends it with the app; the broker also exits when
 * the port closes or main's pid is gone (execBrokerChild.ts).
 */
export function spawnExecBrokerChild(): ExecBrokerLink {
  const child = utilityProcess.fork(join(__dirname, 'execBroker.js'), [], { serviceName: 'TempCode Exec', stdio: 'inherit' })
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ t: 'port', mainPid: process.pid }, [port2])
  return {
    wire: brokerPort(port1),
    kill: () => void child.kill(),
    onExit: (fn) => void child.once('exit', (code) => fn(code))
  }
}
