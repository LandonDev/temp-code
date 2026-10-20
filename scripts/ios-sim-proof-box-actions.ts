/**
 * The live steering pass against the box: the phone sends one cheap real
 * turn (claude-haiku-5-5, reasoning low) into a scratch workspace under
 * /srv/agents/work and reads the reply; then, re-paired with a key that may
 * approve, it sends a turn that asks for a tool under the ask-for-everything
 * policy, approves it from the card, and sees the tool's result.
 *
 * Everything on the box goes over key SSH and `tc-local` (the implicit
 * admin): two pairings (read+operate, then read+operate+approve), the
 * workspace and the two threads. Afterwards the threads are archived and
 * the keys the pairings produced, and the pairings, are revoked. Nothing
 * here prints a code or a key; the proof script scrubs its own output.
 *
 *   bun scripts/ios-sim-proof-box-actions.ts
 *   TC_ORIGIN overrides https://tempcode.landonhale.com; TC_SIM and TC_PROOF_DIR pass through.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const ORIGIN = (process.env.TC_ORIGIN ?? 'https://tempcode.landonhale.com').replace(/\/+$/, '')
const runName = `ios actions ${Date.now()}`
const SCRATCH = '/srv/agents/work/l5-phone-scratch'

function ssh(command: string): string {
  const result = Bun.spawnSync(['ssh', '-o', 'BatchMode=yes', 'box', command], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`box: ${command.split(' ').slice(0, 2).join(' ')} failed: ${result.stderr.toString().slice(0, 200)}`)
  return result.stdout.toString()
}

function local(method: string, params: unknown = {}): unknown {
  const quoted = JSON.stringify(params).replaceAll("'", "'\\''")
  return JSON.parse(ssh(`tc-local ${method} '${quoted}'`))
}

type Meta = { id: string; title: string; status: string }
type Row = { seq: number; event: { type: string; text?: string; allow?: boolean; requestId?: string; isError?: boolean; output?: unknown; name?: string } }

// The scratch workspace: a git repo under the agents' work dir, made as the agents user (ssh lands as root), once.
ssh(`sudo -u agents sh -c 'mkdir -p ${SCRATCH} && cd ${SCRATCH} && ([ -d .git ] || (git init -q && git -c user.name=l5 -c user.email=l5@example.com commit -q --allow-empty -m init))'`)
const workspaces = local('workspace.list') as { id: string; path: string }[]
const workspace = workspaces.find((w) => w.path === SCRATCH) ?? (local('workspace.create', { path: SCRATCH, name: 'l5-phone-scratch' }) as { id: string })
const base = { provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', threadType: 'chat', workspaceId: workspace.id, cwd: SCRATCH }
const chat = local('session.create', { ...base, permission: 'edits', title: 'L5 phone pass' }) as Meta
const asking = local('session.create', { ...base, permission: 'safe', title: 'L5 approval pass' }) as Meta
console.log(`ios-sim-proof-box-actions: scratch workspace and two haiku threads ready on ${ORIGIN}`)

const operate = local('remote.pairings.create', { name: `${runName} operate`, audience: 'client', caps: ['read', 'operate'] }) as { code: string }
const approve = local('remote.pairings.create', { name: `${runName} approve`, audience: 'client', caps: ['read', 'operate', 'approve'] }) as { code: string }
console.log('ios-sim-proof-box-actions: pairings minted (operate; operate+approve)')

let status = 1
try {
  const proof = spawnSync('sh', [resolve(repo, 'scripts/ios-sim-proof.sh')], {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...process.env,
      TC_PROOF_SET: 'box-actions',
      TC_TEST_PAIR_LINK: `${ORIGIN}/pair#${operate.code}`,
      TC_TEST_PAIR_LINK_OPERATE: `${ORIGIN}/pair#${approve.code}`,
      TC_TEST_PAIR_NAME: process.env.TC_TEST_PAIR_NAME ?? 'The box',
      TC_BOX_THREAD: chat.title,
      TC_BOX_APPROVE_THREAD: asking.title,
      TC_PROOF_DIR: process.env.TC_PROOF_DIR ?? '/tmp/tc-ios-proof-box-actions'
    }
  })
  status = proof.status ?? 1

  // What landed on the host, read back the admin way.
  const rows = (id: string): Row[] => {
    const answer = local('session.events', { sessionId: id, tail: 40 }) as Row[] | { rows?: Row[] }
    return Array.isArray(answer) ? answer : (answer.rows ?? [])
  }
  const chatRows = rows(chat.id)
  const pong = chatRows.some((r) => r.event.type === 'assistant-text' && /pong/i.test(r.event.text ?? ''))
  const sent = chatRows.some((r) => r.event.type === 'user-text' && /pong/.test(r.event.text ?? ''))
  const askRows = rows(asking.id)
  const asked = askRows.some((r) => r.event.type === 'approval-request')
  const allowed = askRows.some((r) => r.event.type === 'approval-resolved' && r.event.allow === true)
  const ran = askRows.some((r) => r.event.type === 'tool-result' && JSON.stringify(r.event.output ?? '').includes('approved-from-the-phone'))
  const chatMeta = (local('session.list', {}) as Meta[]).find((m) => m.id === chat.id)
  console.log(`ios-sim-proof-box-actions: chat sent=${sent} replied-pong=${pong} status=${chatMeta?.status ?? '?'}; approval asked=${asked} allowed=${allowed} tool-ran=${ran}`)
  if (!(sent && pong && asked && allowed && ran)) status = status || 5
} finally {
  try {
    for (const id of [chat.id, asking.id]) local('session.archive', { sessionId: id, archived: true })
    const keys = local('remote.keys.list') as { id: string; name: string }[]
    for (const key of keys.filter((key) => key.name.startsWith(runName))) local('remote.keys.revoke', { id: key.id })
    const pairings = local('remote.pairings.list') as { id: string; name: string }[]
    for (const item of pairings.filter((item) => item.name.startsWith(runName))) local('remote.pairings.revoke', { id: item.id })
    console.log('ios-sim-proof-box-actions: the threads are archived; the keys and pairings are revoked')
  } catch {
    console.error('ios-sim-proof-box-actions: could not clean up; archive the L5 threads and revoke the ios actions keys on the box by hand')
    status = status || 1
  }
}
process.exit(status)
