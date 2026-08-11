/** Per-message model/reasoning: send with new opts must persist, restart the
 *  harness via resume, and keep the conversation. Two cheap claude turns. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-ms-')), 'ms.db')))
const registry = new SessionRegistry(store)
const cwd = mkdtempSync(join(tmpdir(), 'tc-ms-cwd-'))

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

done = idle(s.id)
await registry.send(s.id, 'What was the codeword? Reply with just the word.', { model: 'claude-opus-5', reasoning: 'medium' })
await Promise.race([done, new Promise((r) => setTimeout(r, 120_000))])

const meta = store.getSession(s.id)!
const text = registry
  .eventsAfter(s.id, 0)
  .filter((r) => r.event.type === 'assistant-text' && !(r.event as { delta?: boolean }).delta)
  .map((r) => (r.event as { text: string }).text)
  .join(' ')
const ok1 = meta.model === 'claude-opus-5' && meta.reasoning === 'medium'
const ok2 = /pineapple/i.test(text)
console.log(`${ok1 ? 'PASS' : 'FAIL'}  session persisted new model/reasoning (${meta.model}/${meta.reasoning})`)
console.log(`${ok2 ? 'PASS' : 'FAIL'}  conversation survived the harness swap (codeword recalled)`)
await registry.disposeAll()
process.exit(ok1 && ok2 ? 0 : 1)
