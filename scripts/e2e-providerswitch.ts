/** Cross-provider switch mid-thread: send with a new provider must persist,
 *  reset nativeId, boot the new harness with a transcript handoff, and keep
 *  the handoff out of the visible transcript. One claude + one codex turn. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-ps-')), 'ps.db')))
const registry = new SessionRegistry(store)
const cwd = mkdtempSync(join(tmpdir(), 'tc-ps-cwd-'))

const idle = (id: string): Promise<void> =>
  new Promise((resolve) => {
    const off = registry.subscribe(id, (row) => {
      if (row.event.type === 'status' && (row.event.status === 'idle' || row.event.status === 'error')) {
        off()
        resolve()
      }
    })
  })

const s = await registry.create({ provider: 'claude', model: 'claude-sonnet-5', reasoning: 'low', cwd, permission: 'safe' })
let done = idle(s.id)
await registry.send(s.id, 'Remember the codeword "pineapple". Reply with just OK.')
await Promise.race([done, new Promise((r) => setTimeout(r, 120_000))])
const claudeNativeId = store.getSession(s.id)!.nativeId

done = idle(s.id)
await registry.send(s.id, 'What was the codeword? Reply with just the word.', { provider: 'codex', model: 'gpt-5.5', reasoning: 'low' })
await Promise.race([done, new Promise((r) => setTimeout(r, 120_000))])

const meta = store.getSession(s.id)!
const rows = registry.eventsAfter(s.id, 0)
const reply = rows
  .filter((r) => r.event.type === 'assistant-text' && !(r.event as { delta?: boolean }).delta)
  .map((r) => (r.event as { text: string }).text)
  .join(' ')
const visibleUser = rows
  .filter((r) => r.event.type === 'user-text')
  .map((r) => (r.event as { text: string }).text)
  .join(' ')

const ok1 = meta.provider === 'codex' && meta.model === 'gpt-5.5'
const ok2 = meta.nativeId !== null && meta.nativeId !== claudeNativeId
const ok3 = /pineapple/i.test(reply)
const ok4 = !visibleUser.includes('<conversation-handoff>')
console.log(`${ok1 ? 'PASS' : 'FAIL'}  session persisted new provider/model (${meta.provider}/${meta.model})`)
console.log(`${ok2 ? 'PASS' : 'FAIL'}  native session is fresh (${claudeNativeId} → ${meta.nativeId})`)
console.log(`${ok3 ? 'PASS' : 'FAIL'}  conversation crossed the harness boundary (codeword recalled)`)
console.log(`${ok4 ? 'PASS' : 'FAIL'}  handoff stays out of the visible transcript`)
await registry.disposeAll()
process.exit(ok1 && ok2 && ok3 && ok4 ? 0 : 1)
