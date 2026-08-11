/** Live probe of `codex app-server` v2: initialize → thread/start →
 *  turn/start, dumping every frame to see exact wire shapes. */
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
const pending = new Map<number, (r: unknown) => void>()
function request(method: string, params?: unknown): Promise<unknown> {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve) => pending.set(id, resolve))
}

const trim = (v: unknown): string => JSON.stringify(v)?.slice(0, 400) ?? 'undefined'

createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    return console.log('RAW', line.slice(0, 200))
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    console.log(`RESPONSE ${msg.id}:`, trim(msg.result ?? msg.error))
    pending.get(msg.id as number)?.(msg.result)
    pending.delete(msg.id as number)
  } else if (msg.method) {
    console.log(`NOTIFY ${msg.method}:`, trim(msg.params))
  }
})

const init = await request('initialize', {
  clientInfo: { name: 'temp-code', title: 'temp-code', version: '0.1.0' }
})
console.log('initialized ok')
const thread = (await request('thread/start', {
  cwd: mkdtempSync(join(tmpdir(), 'tc-cdx-')),
  model: 'gpt-5.5',
  approvalPolicy: 'never',
  sandbox: 'workspace-write'
})) as { thread?: { id?: string } }
const threadId = thread?.thread?.id
console.log('threadId =', threadId)
if (threadId) {
  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Reply with exactly: CODEX-PONG' }]
  })
}
setTimeout(() => {
  proc.kill()
  process.exit(0)
}, 60_000)
