/** Live probe of claude /goal mechanics on the installed CLI via the Agent
 *  SDK: set/clear syntax, whether query() yields active_goal messages,
 *  emission timing, met-vs-cleared discrimination. */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'tc-goal-claude-'))
console.log('cwd', cwd)

class Q implements AsyncIterable<SDKUserMessage> {
  buffer: SDKUserMessage[] = []
  waiters: ((v: IteratorResult<SDKUserMessage>) => void)[] = []
  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: ''
    }
    const w = this.waiters.shift()
    if (w) w({ value: msg, done: false })
    else this.buffer.push(msg)
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const b = this.buffer.shift()
        if (b) return Promise.resolve({ value: b, done: false })
        return new Promise((r) => this.waiters.push(r))
      }
    }
  }
}

const input = new Q()
const q = query({
  prompt: input,
  options: {
    cwd,
    model: 'claude-sonnet-5-5',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: false
  }
})

let phase = 0
const turnsDone: (() => void)[] = []
const waitTurn = (): Promise<void> => new Promise((r) => turnsDone.push(r))

void (async () => {
  for await (const msg of q) {
    const m = msg as Record<string, unknown>
    if (m.type === 'active_goal') {
      console.log(`[p${phase}] ACTIVE_GOAL`, JSON.stringify(m.value))
    } else if (m.type === 'result') {
      console.log(`[p${phase}] RESULT`, m.subtype)
      turnsDone.shift()?.()
    } else if (m.type === 'assistant') {
      const parts = (m.message as { content: { type: string; text?: string; name?: string }[] })
        .content
      for (const b of parts)
        console.log(`[p${phase}] ASSISTANT ${b.type}`, (b.text ?? b.name ?? '').slice(0, 120))
    } else if (m.type === 'system' && (m as { subtype?: string }).subtype === 'init') {
      console.log(`[p${phase}] INIT session`, m.session_id)
    } else if (m.type === 'local_command_output') {
      console.log(`[p${phase}] LOCAL_CMD_OUT`, JSON.stringify(m).slice(0, 300))
    } else {
      console.log(`[p${phase}] msg type=${m.type}${m.subtype ? '/' + m.subtype : ''}`)
    }
  }
})()

// Phase 1: set a goal. Does it run as a command turn? Does active_goal emit now?
phase = 1
console.log('--- p1: send "/goal the file GOAL_MET.txt exists in the working directory"')
input.push('/goal the file GOAL_MET.txt exists in the working directory')
await waitTurn()

// Phase 2: a task that does NOT meet the goal — watch iterations/last_reason,
// then the agent should keep going until it creates the file → value null (met).
phase = 2
console.log('--- p2: send a message; goal loop should continue until met')
input.push('Say exactly "hello" and stop. Do not create any files unless you must.')
await waitTurn()

// Phase 3: set a fresh goal, then clear it — compare the "cleared" stream
// against p2's "met" stream.
phase = 3
console.log('--- p3: set new goal')
input.push('/goal the file NEVER.txt exists in the working directory')
await waitTurn()

phase = 4
console.log('--- p4: send "/goal clear"')
input.push('/goal clear')
await waitTurn()

phase = 5
console.log('--- p5: clear with no goal set')
input.push('/goal clear')
await waitTurn()

console.log('--- done')
process.exit(0)
