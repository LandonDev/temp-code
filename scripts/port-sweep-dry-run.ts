/**
 * The host-wide dev server sweep (src/main/server/portSweep.ts) as a dry run
 * against this machine: every TCP listener, the verdict for each and the
 * thread it would be credited to. Records nothing. The threads, their live
 * port rows and the host's pid come from the running headless host through
 * tc-local; a Claude harness's pid from its own environment (the `~t=` scope
 * names its thread). Run on the box:
 *
 *   bun scripts/port-sweep-dry-run.ts
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadResource } from '../src/shared/contract-resources'
import type { SessionMeta } from '../src/shared/events'
import { LIVE_STATUSES } from '../src/shared/session-lifecycle'
import { parseEnviron, PortSweep } from '../src/main/server/portSweep'
import { scanHost, SharedScanner } from '../src/main/server/threadPorts'

const tc = <T>(method: string, params: object = {}): T =>
  JSON.parse(execFileSync('tc-local', [method, JSON.stringify(params)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) as T

const userData = process.env.TEMP_CODE_USER_DATA || '/srv/agents/temp-code-data'
const port = JSON.parse(readFileSync(join(userData, 'server.json'), 'utf8')).port as number
const scan = await scanHost()
const hostPid = scan.listeners.find((l) => l.port === port)?.pid
if (!hostPid) throw new Error(`nothing listens on the host's port ${port}`)

const listed = tc<{ sessions: SessionMeta[] } | SessionMeta[]>('session.list')
const sessions = Array.isArray(listed) ? listed : listed.sessions
const resources = tc<{ resources: ThreadResource[] } | ThreadResource[]>('resources.listAll')
const rows = (Array.isArray(resources) ? resources : resources.resources).filter((r) => r.kind === 'port' && r.removedAt === null)

// A harness is a child of the host; a Claude one names its thread in its environment.
const harness = new Map<string, number>()
for (const [pid, ppid] of scan.parents) {
  if (ppid !== hostPid) continue
  let environ = ''
  try {
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8')
  } catch {
    continue
  }
  const { threadId } = parseEnviron(environ)
  if (threadId) harness.set(threadId, pid)
}

const sweep = new PortSweep({
  resources: {
    live: (_env, _kind, identifier) => rows.find((r) => r.identifier === identifier) ?? null,
    record: () => {
      throw new Error('a dry run records nothing')
    }
  },
  environmentId: 'dry-run',
  scanner: new SharedScanner(async () => scan),
  threads: () =>
    sessions.map((m) => {
      const harnessPid = harness.get(m.id) ?? null
      return { id: m.id, cwd: m.cwd, harnessPid, live: harnessPid !== null || LIVE_STATUSES.has(m.status), createdAt: m.createdAt, activeAt: m.updatedAt }
    }),
  anyLive: () => true,
  claimed: () => false,
  ownPid: hostPid
})

const title = new Map(sessions.map((s) => [s.id, `${s.title} (${s.id.slice(0, 12)}, ${s.cwd})`]))
const reports = (await sweep.sweep({ dryRun: true })).sort((a, b) => a.port - b.port)
console.log(`host pid ${hostPid}, ${sessions.length} threads, ${harness.size} Claude harnesses, ${rows.length} live port rows, ${readdirSync('/proc').length} /proc entries`)
for (const r of reports) {
  const v = r.verdict
  const what = 'credit' in v ? `→ ${title.get(v.credit.sessionId) ?? v.credit.sessionId} by ${v.credit.by}` : `skip: ${v.skip}`
  console.log(`:${r.port} pid ${r.pid} ${r.process.slice(0, 70)}${r.cwd ? ` [${r.cwd}]` : ''}\n    ${what}`)
}
