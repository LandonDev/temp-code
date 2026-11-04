import { runExecBrokerChild } from './server/execBrokerChild'
import { brokerPort, type BrokerPortLike } from './server/execBrokerWire'

/**
 * Entry of the exec broker's utility process (execBrokerSpawn.ts forks it):
 * main transfers one MessagePortMain and its pid, and the broker runs helper
 * children over it until main is gone (execBrokerChild.ts). Nothing of the
 * server bundle loads here: the process stays a few dozen MB, so its forks
 * stay cheap.
 */
process.parentPort.once('message', (e) => {
  const [port] = e.ports
  if (!port) process.exit(1)
  const { mainPid } = (e.data ?? {}) as { mainPid?: number }
  runExecBrokerChild(brokerPort(port as unknown as BrokerPortLike), { mainPid, exit: () => process.exit(0) })
})
