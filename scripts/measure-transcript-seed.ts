/**
 * Seeds the scratch database scripts/measure-transcript.ts measures against:
 * a 2,000-row chat of the shape the iOS test server seeds (500 turns of a
 * prompt, a Read call and its result, and an answer, every seventh with a
 * list and a code fence). Bundled with the electron shim and run under node
 * (bun run script:measure-transcript-seed), as the other server scripts are.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { startServer } from '../src/main/server/index'

const ROOT = process.env.TC_MEASURE_ROOT ?? '/tmp/tc-transcript-measure'
const USER_DATA = join(ROOT, 'userData')
export const SESSION = 'measure-long'
const TURNS = 500

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(USER_DATA, { recursive: true })
configure({
  dataDir: join(ROOT, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-measure'
})
const server = await startServer(join(USER_DATA, 'temp-code.db'), { claimShim: false, remotePort: 0 })
const repo = join(ROOT, 'repo')
mkdirSync(repo, { recursive: true })
execFileSync('git', ['-C', repo, 'init', '-q'])
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
const workspace = await server.registry.createWorkspace(repo, 'measure')
const project = await server.registry.createProject(workspace.id, 'measure-project', 'local')
const make = (id: string, title: string) =>
  server.registry.create({ id, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', projectId: project.id, threadType: 'chat', title })
await make('measure-short', 'Short')
server.registry.append('measure-short', { type: 'user-text', text: 'hello' })
server.registry.append('measure-short', { type: 'assistant-text', text: 'hi', delta: false, msgId: 's1', blockIndex: 0 })
server.registry.append('measure-short', { type: 'turn-complete' })
await make(SESSION, '2,000 rows')
for (let i = 0; i < TURNS; i++) {
  server.registry.append(SESSION, { type: 'user-text', text: `Turn ${i + 1}: what does row ${i * 4 + 1} say?` })
  server.registry.append(SESSION, { type: 'tool-call', callId: `l${i}`, name: 'Read', input: { file_path: `src/row-${i}.ts` }, preview: { kind: 'read', path: `src/row-${i}.ts`, fileName: `row-${i}.ts` } })
  server.registry.append(SESSION, { type: 'tool-result', callId: `l${i}`, output: `row ${i}`, isError: false })
  server.registry.append(SESSION, {
    type: 'assistant-text',
    delta: false,
    msgId: `lm${i}`,
    blockIndex: 0,
    text:
      i % 7 === 0
        ? `Row ${i} holds a **bold** claim and a list:\n\n- one\n- two\n\n\`\`\`ts\nconst row = ${i}\n\`\`\``
        : `Row ${i} says \`${i * 4 + 1}\` and nothing more.`
  })
  server.registry.append(SESSION, { type: 'turn-complete' })
}
server.registry.append(SESSION, { type: 'status', status: 'idle' })
await server.close()
console.log(`seeded ${SESSION} with ${TURNS * 4} rows under ${USER_DATA}`)
process.exit(0)
