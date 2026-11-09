/** Last-resort cleanup, installed before a proof can start any child. */
import type { ChildProcess } from 'node:child_process'
import { createProcScan, hasEnv } from './procScan'

export function proofCleanup(
  root: string,
  options: {
    events?: Pick<NodeJS.Process, 'on'>
    kill?: (pid: number, signal: NodeJS.Signals) => void
    scan?: ReturnType<typeof createProcScan>
    exit?: (code: number) => never | void
    error?: (error: unknown) => void
  } = {}
) {
  const events = options.events ?? process
  const kill = options.kill ?? process.kill.bind(process)
  const scan = options.scan ?? createProcScan()
  const exit = options.exit ?? process.exit
  const error = options.error ?? console.error
  const children: { pid: number; group: boolean }[] = []
  const stop = (): void => {
    for (const child of children) {
      try {
        kill(child.group ? -child.pid : child.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    // Electron utility children can leave their original process group.
    for (const row of scan.processes()) {
      if (
        row.pid !== process.pid &&
        (hasEnv(row, `TEMP_CODE_USER_DATA=${root}/`, true) || row.command.includes(root))
      ) {
        try {
          kill(row.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
  }
  const safeStop = (): void => {
    try {
      stop()
    } catch (err) {
      error(err)
    }
  }
  events.on('exit', safeStop)
  events.on('SIGINT', () => {
    safeStop()
    exit(130)
  })
  events.on('SIGTERM', () => {
    safeStop()
    exit(143)
  })
  const fatal = (err: unknown): void => {
    error(err)
    safeStop()
    exit(1)
  }
  events.on('uncaughtException', fatal)
  events.on('unhandledRejection', fatal)
  return {
    stop,
    track(child: ChildProcess, group = false): void {
      if (child.pid) children.push({ pid: child.pid, group })
      child.on('error', fatal)
    }
  }
}
