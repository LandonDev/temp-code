/** One real short turn each on GPT-6 Sol (codex), Sonnet 5.5 and Haiku 5.5
 *  (claude) through the session registry. Pass one model id to run only it.
 *  The codex driver uses the login-shell codex; a CLI older than 0.162 answers
 *  the Sol ids with a 400 ("not supported when using Codex with a ChatGPT
 *  account"), which this script reports as a FAIL with that message. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-nm-')), 'nm.db')))
const registry = new SessionRegistry(store)
const cwd = mkdtempSync(join(tmpdir(), 'tc-nm-cwd-'))

const idle = (id: string): Promise<void> =>
  new Promise((resolve) => {
    const off = registry.subscribe(id, (row) => {
      if (row.event.type === 'status' && (row.event.status === 'idle' || row.event.status === 'error')) {
        off()
        resolve()
      }
    })
  })

const cases: Array<{ provider: 'claude' | 'codex'; model: string; reasoning: string }> = [
  { provider: 'codex', model: 'gpt-6-sol', reasoning: 'low' },
  { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low' },
  { provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low' },
]
const only = process.argv[2]
let allOk = true
for (const c of cases) {
  if (only && c.model !== only) continue
  const s = await registry.create({ provider: c.provider, model: c.model, reasoning: c.reasoning, cwd, permission: 'safe' })
  const done = idle(s.id)
  await registry.send(s.id, 'Reply with exactly: PONG ' + c.model)
  await Promise.race([done, new Promise((r) => setTimeout(r, 180_000))])
  const rows = registry.eventsAfter(s.id, 0)
  const text = rows
    .filter((r) => r.event.type === 'assistant-text' && !(r.event as { delta?: boolean }).delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')
  const errs = rows.filter((r) => r.event.type === 'error').map((r) => JSON.stringify(r.event)).join(' | ')
  const meta = store.getSession(s.id)!
  const ok = /PONG/i.test(text) && meta.model === c.model
  allOk &&= ok
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.provider}/${c.model} (${meta.model}) → ${JSON.stringify(text.slice(0, 80))}${errs ? '  ERR: ' + errs.slice(0, 300) : ''}`)
}
await registry.disposeAll()
process.exit(allOk ? 0 : 1)
