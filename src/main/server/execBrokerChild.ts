import { spawn, type ChildProcess } from 'node:child_process'
import type { BrokerError, BrokerPort, ChildMessage, MainMessage } from './execBrokerWire'

/**
 * The broker's side: run helper children for main over one port
 * (execBrokerWire.ts). Pure node, no Electron and nothing of the server
 * bundle: it is the whole of the broker process (src/main/execBrokerProcess.ts)
 * and the in-process fallback alike. The semantics are `execFile`'s, done
 * here on `spawn`: a timeout kills with `killSignal`, a buffered ask past
 * `maxBuffer` is killed and fails with ERR_CHILD_PROCESS_STDIO_MAXBUFFER, a
 * non-zero exit or a signal is "Command failed: <cmd>\n<stderr>", and a
 * spawn error (ENOENT) carries its errno fields. Every child dies with the
 * link: the port closing or main's pid gone SIGKILLs what is still running.
 */

export type BrokerChildPort = BrokerPort<MainMessage, ChildMessage>

export interface BrokerChildDeps {
  /** Main's pid, polled every `watchMainMs` (5 s; 0 never): gone, the children are killed and `exit` runs. */
  mainPid?: number
  watchMainMs?: number
  exit?: () => void
}

export function runExecBrokerChild(wire: BrokerChildPort, deps: BrokerChildDeps = {}): () => void {
  const live = new Map<number, ChildProcess>()
  const killAll = (): void => {
    for (const cp of live.values()) {
      try {
        cp.kill('SIGKILL')
      } catch {
        // gone already
      }
    }
    live.clear()
  }
  wire.onMessage((m) => {
    switch (m.t) {
      case 'exec':
      case 'spawn':
        start(m)
        return
      case 'stdin': {
        const cp = live.get(m.id)
        if (!cp?.stdin) return
        if (m.chunk === null) cp.stdin.end()
        else cp.stdin.write(Buffer.from(m.chunk))
        return
      }
      case 'kill': {
        const cp = live.get(m.id)
        if (cp) {
          try {
            cp.kill(m.signal)
          } catch {
            // gone already
          }
        }
        return
      }
    }
  })
  wire.onClose(() => {
    killAll()
    deps.exit?.()
  })
  const watchMs = deps.watchMainMs ?? 5_000
  if (deps.mainPid && watchMs > 0) {
    setInterval(() => {
      try {
        process.kill(deps.mainPid!, 0)
      } catch {
        killAll()
        deps.exit?.()
      }
    }, watchMs).unref()
  }

  function start(m: Extract<MainMessage, { t: 'exec' | 'spawn' }>): void {
    const buffered = m.t === 'exec'
    const { id, opts } = m
    const cmd = [m.file, ...m.args].join(' ')
    let cp: ChildProcess
    try {
      cp = spawn(m.file, m.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      wire.post({ t: 'started', id, pid: undefined })
      wire.post({ t: 'done', id, code: null, signal: null, error: errnoError(e as NodeJS.ErrnoException) })
      return
    }
    live.set(id, cp)
    // node sets the pid as spawn returns (undefined when it failed: `error` follows).
    wire.post({ t: 'started', id, pid: cp.pid })
    cp.stdin?.on('error', () => {
      // The child exited before reading: the exit says so.
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let overflow: 'stdout' | 'stderr' | null = null
    let spawnError: NodeJS.ErrnoException | null = null
    let finished = false
    const killSignal = opts.killSignal ?? 'SIGTERM'
    const timer = opts.timeout && opts.timeout > 0 ? setTimeout(() => cp.kill(killSignal), opts.timeout) : null
    const sink = (fd: 1 | 2, chunks: Buffer[], name: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      if (!buffered) {
        wire.post({ t: 'out', id, fd, chunk })
        return
      }
      const len = fd === 1 ? (outLen += chunk.length) : (errLen += chunk.length)
      if (opts.maxBuffer && len > opts.maxBuffer) {
        if (!overflow) {
          overflow = name
          chunks.push(chunk.subarray(0, chunk.length - (len - opts.maxBuffer)))
          cp.kill(killSignal)
        }
        return
      }
      chunks.push(chunk)
    }
    cp.stdout?.on('data', sink(1, out, 'stdout'))
    cp.stderr?.on('data', sink(2, err, 'stderr'))
    cp.once('error', (e: NodeJS.ErrnoException) => {
      spawnError = e
      // A spawn failure (ENOENT) has no process: `close` may not follow.
      if (cp.pid === undefined) finish(null, null)
    })
    cp.once('close', (code, signal) => finish(code, signal))

    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      live.delete(id)
      let error: BrokerError | undefined
      if (spawnError) error = errnoError(spawnError)
      else if (overflow) {
        error = { message: `${overflow} maxBuffer length exceeded`, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: cp.killed, signal }
      } else if (code !== 0 || signal) {
        error = { message: `Command failed: ${cmd}\n${buffered ? Buffer.concat(err).toString('utf8') : ''}`, code, signal, killed: cp.killed }
      }
      wire.post({
        t: 'done',
        id,
        code,
        signal,
        ...(buffered ? { stdout: Buffer.concat(out), stderr: Buffer.concat(err) } : {}),
        ...(error ? { error } : {})
      })
    }
  }

  wire.post({ t: 'ready', pid: process.pid })
  return killAll
}

const errnoError = (e: NodeJS.ErrnoException): BrokerError => ({
  message: e.message,
  code: e.code ?? null,
  errno: e.errno,
  syscall: e.syscall,
  path: e.path
})
