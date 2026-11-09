/** Live image transport proof. Uses real harness drivers and a fake Mac service. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setAppBridge, setAppToolsRegistry } from '../src/main/server/apptools'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { computerHooks, type ComputerHost } from '../src/main/server/computer/mcp'
import { ComputerService } from '../src/main/server/computer/service'
import { ComputerSessions } from '../src/main/server/computer/sessions'
import { ComputerRpc } from '../src/main/server/computer/rpc'
import { fakeServiceBin } from '../src/main/server/computer/testFake'
import { MacThreadTokens } from '../src/main/server/macTools'
import { probeCatalog } from '../src/main/server/drivers/harness/museCatalog'
import { checkProvider } from '../src/main/server/drivers/binaries'
import type { ProviderId } from '../src/shared/catalog'
import { codeImage } from './lib/codeImage'
import { judgeComputerImages } from './lib/computerImageProof'

process.env.TEMP_CODE_E2E_STATUS = '1'
process.env.TEMP_CODE_WARM_HARNESS = '0'
process.env.TBH_CREDENTIAL_BACKEND ??= 'file'
process.env.MUSE_CONTRIBUTOR_MODE ??= '0'
const arg = process.argv.indexOf('--harness')
const requested = arg < 0 ? ['claude', 'codex'] : [process.argv[arg + 1]]
if (requested.some((h) => !['claude', 'codex', 'muse'].includes(h)))
  throw new Error('--harness must be claude, codex or muse')
const reportPath =
  process.env.TEMP_CODE_IMAGE_REPORT ??
  '/srv/agents/work/temp-code/.temp-code/computer-images/box.json'
const scratch = mkdtempSync(join(tmpdir(), 'tc-computer-images-'))
const db = openDb(join(scratch, 'app.db'))
const store = new Store(db)
const registry = new SessionRegistry(store)
setAppToolsRegistry(registry)
setOrchestrationRegistry(registry)
registry.hostName = () => 'computer-image-proof'
const workspace = join(scratch, 'workspace')
mkdirSync(workspace)
const fixture = resolve('src/main/server/computer/fixtures/apps/textedit/save-sheet/window.jpg')
const report: {
  measuredAt: string
  host: string
  results: Record<string, unknown>[]
  skipped: string[]
} = {
  measuredAt: new Date().toISOString(),
  host: process.platform,
  results: [],
  skipped: []
}
function save(): void {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
}
// Kill only this proof's descendants by pid, including an interrupted harness's bridge.
function childPids(): number[] {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((s) => s.trim().split(/\s+/).map(Number))
  const owned = new Set([process.pid])
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid)
        changed = true
      }
  }
  return [...owned].reverse().filter((pid) => pid !== process.pid)
}
function killPids(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already exited */
    }
  }
}
const killChildren = (): void => killPids(childPids())
process.on('exit', killChildren)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    save()
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  })

let current: ComputerHost | null = null
let rpc: ComputerRpc | null = null
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) => server.once('listening', resolve))
server.on('connection', (ws) => {
  const socket = rpc!.socket()
  ws.on('close', () => socket.close())
  ws.on('message', async (bytes) => {
    const req = JSON.parse(String(bytes))
    try {
      const result =
        req.method === 'app.computerTools'
          ? socket.tools(req.params)
          : req.method === 'app.computer'
            ? await socket.call(req.params)
            : req.method === 'app.computerCancel'
              ? socket.cancel(req.params)
              : (() => {
                  throw new Error(`outside picture proof: ${req.method}`)
                })()
      ws.send(JSON.stringify({ id: req.id, ok: true, result }))
    } catch (e) {
      ws.send(JSON.stringify({ id: req.id, ok: false, error: String(e) }))
    }
  })
})
setAppBridge({
  port: (server.address() as { port: number }).port,
  command: process.execPath,
  scriptPath: resolve('scripts/app-mcp-bridge.mjs'),
  env: {}
})
const offMeta = registry.onMeta((meta) => current?.sessions.onMeta(meta))

async function settled(id: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const isEnd = (event: { type: string; status?: string }) =>
      event.type === 'turn-complete' ||
      (event.type === 'status' && ['waiting', 'error', 'idle'].includes(event.status ?? ''))
    if (registry.eventsAfter(id, 0).some((r) => isEnd(r.event))) return resolve()
    const timer = setTimeout(() => {
      off()
      reject(new Error('turn timed out after 180000 ms'))
    }, 180_000)
    const off = registry.subscribe(id, (r) => {
      if (isEnd(r.event)) {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
}

try {
  for (const harness of requested as ProviderId[]) {
    if (harness === 'muse') {
      const catalog = await probeCatalog().catch((e) => {
        throw new Error(`Muse catalog probe failed: ${String(e)}`)
      })
      if (!catalog?.models.length) {
        const line = 'SKIP muse: no Muse model is listed on this host'
        console.log(line)
        report.skipped.push(line)
        save()
        continue
      }
    }
    const binary = await checkProvider(harness)
    for (const mode of harness === 'codex' ? ['parts', 'steer', 'view'] : ['parts']) {
      process.env.TEMP_CODE_CODEX_COMPUTER_IMAGES = mode
      for (const count of [1, 2]) {
        const caseName = count === 1 ? 'code' : 'fixture-and-code'
        const caseDir = join(scratch, `${harness}-${mode}-${count}`)
        mkdirSync(caseDir)
        const image = codeImage(join(caseDir, 'code.png'))
        const service = new ComputerService({
          dataDir: join(caseDir, 'computer'),
          bin: fakeServiceBin,
          env: {
            ...process.env,
            FAKE_SHOT_FILES: count === 1 ? image.path : `${fixture},${image.path}`
          }
        })
        const sessions = new ComputerSessions({
          service,
          registry: {
            get: (id) => registry.get(id),
            requestApproval: (id, req) => registry.requestApproval(id, req),
            awayOn: () => false
          },
          store,
          dataDir: caseDir,
          landing: (id) => join(caseDir, 'attachments', id)
        })
        current = {
          available: () => true,
          service,
          sessions,
          tokens: new MacThreadTokens(null, 'computer')
        }
        computerHooks.current = current
        rpc = new ComputerRpc(current)
        let id: string | undefined
        let error = ''
        console.log(`RUN ${harness} ${mode} ${caseName}`)
        try {
          const thread = await registry.create({
            provider: harness,
            model:
              harness === 'claude'
                ? 'claude-sonnet-5-5'
                : harness === 'codex'
                  ? 'gpt-6.1-sol'
                  : 'muse-spark-1.3',
            reasoning: 'low',
            permission: 'auto',
            agentType: 'implementer',
            cwd: workspace,
            threadType: 'chat',
            parentId: null
          })
          id = thread.id
          const prompt =
            'This is a screenshot transport test. Ask no questions, spawn no threads, and use no shell. Call computer_observe with app "TextEdit" and screenshot: true.' +
            (count === 2
              ? ' Then call computer_act with app "TextEdit", action "screenshot". The first picture is a normal window; the second picture holds the code.'
              : '') +
            (mode === 'view'
              ? ' Call view_image on each screenshot path from the tool results to see the pictures.'
              : ' Read only the pictures delivered to you; do not open any screenshot file with Read, view_image or a shell.') +
            ' Answer with the six letters the code picture shows and nothing else.'
          await registry.send(id, prompt)
          await settled(id)
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        const events = id ? registry.eventsAfter(id, 0).map((r) => r.event) : []
        const verdict = judgeComputerImages(events, image.letters, mode, count)
        if (error) {
          verdict.pass = false
          verdict.why = [error, verdict.why].filter(Boolean).join('; ')
        }
        report.results.push({
          harness,
          cliVersion: binary.version ?? 'unknown',
          mode,
          case: caseName,
          expected: image.letters,
          ...verdict,
          events
        })
        save()
        console.log(
          `${verdict.pass ? 'PASS' : 'FAIL'} ${harness} ${mode} ${caseName}: ${verdict.reply || verdict.why}`
        )
        // End only proof-owned processes; each case gets its own host and harness.
        const pids = childPids()
        if (id) {
          await registry.delete(id)
          await sessions.end([id])
        }
        rpc.close()
        rpc = null
        await service.close()
        killPids(pids)
        current = null
        computerHooks.current = null
      }
    }
  }
} finally {
  save()
  offMeta()
  killChildren()
  await registry.close()
  await current?.service.close()
  rpc?.close()
  server.close()
  setAppBridge(null)
  computerHooks.current = null
  db.close()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`Report: ${reportPath}`)
process.exit(report.results.every((r) => r.pass) ? 0 : 1)
