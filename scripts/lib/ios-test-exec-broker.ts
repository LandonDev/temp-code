/**
 * The iOS test server's exec broker: what src/main/execBrokerProcess.ts is
 * to the app, for a host that runs under node with no Electron. The test
 * server (scripts/ios-client-test-server.ts) forks it when
 * TC_TEST_EXEC_BROKER names this file's bundle, and every helper child the
 * server runs (the process guard's `ps`, git) starts from here over the
 * fork's IPC channel. In process, each of those spawns held the server's
 * loop for a second or more on a busy Mac, and the pushes a perf run
 * measures came a few a minute.
 */
import { runExecBrokerChild } from '../../src/main/server/execBrokerChild'
import { brokerPort, type BrokerPortLike } from '../../src/main/server/execBrokerWire'

const port = {
  postMessage: (message: unknown) => void process.send?.(message),
  on: (event: 'message' | 'close', fn: (e?: { data: unknown }) => void) =>
    event === 'message' ? process.on('message', (data) => fn({ data })) : process.on('disconnect', () => fn()),
  start: () => {},
  close: () => process.disconnect?.()
} as unknown as BrokerPortLike
runExecBrokerChild(brokerPort(port), { mainPid: Number(process.env.TC_TEST_EXEC_MAIN_PID) || undefined, exit: () => process.exit(0) })
