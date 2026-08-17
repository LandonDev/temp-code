/** Live probe of codex app-server goal RPCs: thread/goal/set|get|clear
 *  and the updated/cleared notifications. Sends deliberately-wrong params
 *  first so serde errors reveal the exact field list. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const proc = spawn('/opt/homebrew/bin/codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env
})
proc.stderr.on('data', (d) => console.error('STDERR', String(d).slice(0, 300)))

let nextId = 1
const pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>()
function request(method: string, params?: unknown): Promise<{ result?: unknown; error?: unknown }> {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve) => pending.set(id, resolve))
}

const trim = (v: unknown): string => JSON.stringify(v)?.slice(0, 600) ?? 'undefined'

createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    return console.log('RAW', line.slice(0, 200))
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    pending.get(msg.id as number)?.({ result: msg.result, error: msg.error })
    pending.delete(msg.id as number)
  } else if (msg.method) {
    if (String(msg.method).includes('goal')) console.log(`NOTIFY ${msg.method}:`, trim(msg.params))
  }
})

await request('initialize', {
  clientInfo: { name: 'temp-code', title: 'temp-code', version: '0.1.0' }
})
console.log('initialized')
const t = (await request('thread/start', {
  cwd: mkdtempSync(join(tmpdir(), 'tc-goal-')),
  model: 'gpt-5.5',
  approvalPolicy: 'never',
  sandbox: 'read-only'
})) as { result?: { thread?: { id?: string } } }
const threadId = t.result?.thread?.id
console.log('threadId', threadId)

const show = async (label: string, method: string, params?: unknown): Promise<void> => {
  const r = await request(method, params)
  console.log(`${label} →`, r.error ? `ERROR ${trim(r.error)}` : trim(r.result))
}

await show('set {}', 'thread/goal/set', {})
await show('set {threadId}', 'thread/goal/set', { threadId })
await show('get (no goal)', 'thread/goal/get', { threadId })
await show('set full', 'thread/goal/set', { threadId, objective: 'probe objective: all tests pass' })
await show('get (with goal)', 'thread/goal/get', { threadId })
await show('set replace', 'thread/goal/set', { threadId, objective: 'replaced objective' })
await show('set with budget', 'thread/goal/set', {
  threadId,
  objective: 'budgeted objective',
  tokenBudget: 50000
})
await show('clear', 'thread/goal/clear', { threadId })
await show('get (cleared)', 'thread/goal/get', { threadId })
await show('clear again', 'thread/goal/clear', { threadId })

// give notifications a beat to flush
await new Promise((r) => setTimeout(r, 1500))
proc.kill()
process.exit(0)
