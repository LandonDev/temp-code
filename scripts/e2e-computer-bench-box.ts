/**
 * The field suite's box half (docs/computer-protocol.md §21.7): an isolated
 * headless TempCode instance on the box whose REAL model threads make the
 * computer calls that come back to the Mac's tc-computer over the Mac
 * bridge. Started over SSH by `e2e-computer-bench.ts --set field --host box`
 * on the Mac, never by hand against the box's temp-code.service.
 *
 *   bun scripts/e2e-computer-bench-box.ts --port <n>
 *
 * The instance: its own userData and Aliax data dir under /tmp (an empty
 * vault), but the REAL home, so real provider turns run on the box's own CLI
 * logins — TEMP_CODE_DIRECT_PROVIDERS=claude,codex leaves both CLIs on their
 * own credentials (~/.claude/.credentials.json, ~/.codex/auth.json), since an
 * isolated instance is not the gateway marker's owner and could not refresh a
 * vault token (CLAUDE.md "Provider traffic"). Its remote listener is the
 * given port, which the Mac reaches through the SSH tunnel.
 *
 * One line `{ ready, envId, key, root }` on stdout (the SSH channel: the key
 * never reaches a file or a log), then `{ id, method, params }` lines on
 * stdin answered `{ id, result | error }` from the instance's local socket;
 * `quit` ends it. Nothing here touches the box's temp-code.service or the
 * person's threads.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const REPO = resolve(import.meta.dir, '..')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const until = async (ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
  }
  return false
}

interface Inst {
  home: string
  data: string
  tmp: string
  log: string
  proc?: ChildProcess
}

const logOf = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const portOf = (inst: Inst): number => (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port

async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`no answer to ${method}`))
    }, 600_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'field', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'field') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`socket error on ${method}`))
    })
  })
}

function kill(inst: Inst): void {
  const pid = inst.proc?.pid
  if (!pid) return
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-pid, sig)
    } catch {
      /* gone */
    }
  }
}

async function main(): Promise<void> {
  const port = Number(arg('--port'))
  if (!Number.isInteger(port)) throw new Error('--port <n> names the remote listener the tunnel reaches')
  if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) throw new Error('out/main is missing on the box: run electron-vite build first')
  const root = mkdtempSync(join(tmpdir(), 'tc-field-box-'))
  const inst: Inst = { home: homedir(), data: join(root, 'data'), tmp: join(root, 'tmp'), log: join(root, 'box.log') }
  const work = join(root, 'work')
  for (const d of [inst.data, inst.tmp, work]) mkdirSync(d, { recursive: true })
  const quit = (): void => {
    kill(inst)
    rmSync(root, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
  process.once('exit', () => {
    kill(inst)
    rmSync(root, { recursive: true, force: true })
  })

  // Entered as root and dropped to agents, the shell keeps root's XDG_RUNTIME_DIR and an AppArmor context
  // where Electron falls back to its setuid sandbox and aborts: this isolated instance runs without either.
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime && process.getuid && !runtime.endsWith(`/${process.getuid()}`)) delete process.env.XDG_RUNTIME_DIR

  const env: Record<string, string> = {
    ...(Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith('TEMP_CODE_') && !k.startsWith('CLAUDE'))) as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_WARM_HARNESS: '0',
    // An empty throwaway vault: every thread passes its CLI's own login through (the rig's recipe, computerRig.ts).
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_DIRECT_PROVIDERS: 'claude,codex',
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_REMOTE_PORT: String(port),
    TEMP_CODE_WORK_ROOT: work,
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ELECTRON_DISABLE_SANDBOX: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv = process.platform === 'linux' ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'] : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.once('error', (error) => appendFileSync(inst.log, `launch failed: ${error.message}\n`))
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc

  if (!(await until(120_000, () => existsSync(join(inst.data, 'server.json'))))) {
    console.log(JSON.stringify({ ready: false, error: 'the box instance did not start', log: logOf(inst).slice(-2_000) }))
    return quit()
  }
  const { environmentId } = await rpc<{ environmentId: string }>(inst, 'remote.status')
  const key = await rpc<{ token: string }>(inst, 'remote.keys.create', { name: 'Field bench Mac', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  console.log(JSON.stringify({ ready: true, envId: environmentId, key: key.token, root, work }))

  const handle = async (req: { id: number; method: string; params: Record<string, unknown> }): Promise<void> => {
    const answer = (out: { result: unknown } | { error: string }): void => console.log(JSON.stringify({ id: req.id, ...out }))
    try {
      if (req.method === 'log') answer({ result: logOf(inst) })
      else answer({ result: await rpc(inst, req.method, req.params) })
    } catch (err) {
      answer({ error: err instanceof Error ? err.message : String(err) })
    }
  }
  for await (const line of createInterface({ input: process.stdin })) {
    let req: { id: number; method: string; params: Record<string, unknown> }
    try {
      req = JSON.parse(line)
    } catch {
      continue
    }
    if (req.method === 'quit') {
      console.log(JSON.stringify({ id: req.id, result: null }))
      break
    }
    void handle(req)
  }
  quit()
}

await main()
