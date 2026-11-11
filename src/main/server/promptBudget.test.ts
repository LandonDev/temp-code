import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { SessionMeta } from '@shared/events'
import { PROMPT_BUDGET, type PromptPart } from '@shared/promptBudget'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { chatSpawnPrompt, implementerSpawnPrompt, orchestratorPrompt, planningSpawnPrompt, researchSpawnPrompt, setOrchestrationRegistry } from './orchestration'
import { appToolsMcp, setAppToolsRegistry } from './apptools'
import { threadPreamble } from './threads'
import { HOUSE_PREAMBLE } from './projectPreamble'
import { cancelMirrors } from './mirror'
import { listedTools } from '../../../scripts/app-mcp-bridge.mjs'

vi.mock('./drivers', () => ({ BUILT_IN_DRIVERS: {} }))

/**
 * The parts of every prompt the host writes, measured from the real code
 * and held to src/shared/promptBudget.ts. A window that the fixed overhead
 * fills thrashes (docs/agents/prompt-overhead.md); these keep the host's
 * share from growing unnoticed. A failure prints the whole table.
 */

let root: string
let db: ReturnType<typeof openDb>
let registry: SessionRegistry
const measured = new Map<PromptPart, number>()
const bytes = (text: string): number => Buffer.byteLength(text)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-prompt-budget-'))
  db = openDb(join(root, 'test.db'))
  registry = new SessionRegistry(new Store(db))
  setOrchestrationRegistry(registry)
  setAppToolsRegistry(registry)
  const ws = join(root, 'repo')
  await mkdir(ws)
  const store = (registry as unknown as { store: Store }).store
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: ws, git: false, createdAt: 1 })
  store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'app', mode: 'local', branch: null, cwd: ws, archived: false, createdAt: 1 })

  const make = async (over: Partial<Parameters<SessionRegistry['create']>[0]>): Promise<SessionMeta> =>
    registry.create({ projectId: 'p1', provider: 'claude', ...over } as Parameters<SessionRegistry['create']>[0])
  const chat = await make({ threadType: 'chat' })
  const planning = await make({ threadType: 'planning' })
  const impl = await make({ threadType: 'implementation' })
  const orch = await make({ threadType: 'orchestration' })
  const research = await make({ threadType: 'research' })
  const master = await make({ threadType: 'chat', master: true })
  const child = await make({ threadType: 'implementation', parentId: impl.id })
  const codexImpl = await make({ provider: 'codex', model: 'gpt-6.1-sol', threadType: 'implementation' })
  const codexChat = await make({ provider: 'codex', model: 'gpt-6.1-sol', threadType: 'chat' })

  measured.set('claude.chat', bytes(chatSpawnPrompt(chat)))
  measured.set('claude.planning', bytes(planningSpawnPrompt(planning)))
  measured.set('claude.implementation', bytes(implementerSpawnPrompt(impl)))
  measured.set('claude.orchestration', bytes(orchestratorPrompt(orch)))
  measured.set('claude.research', bytes(researchSpawnPrompt(research)))
  measured.set('claude.master', bytes(chatSpawnPrompt(registry.get(master.id)!)))
  measured.set('claude.subagent', bytes(implementerSpawnPrompt(child)))
  ;(registry as unknown as { away: { enabled: boolean } | null }).away = { enabled: true }
  measured.set('claude.implementation.away', bytes(implementerSpawnPrompt(impl)))
  ;(registry as unknown as { away: unknown }).away = null

  // The app MCP server as a claude implementation thread lists it.
  const server = appToolsMcp(impl).instance
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'budget', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  measured.set('claude.appTools', bytes(JSON.stringify((await client.listTools()).tools)))
  await client.close()

  measured.set('bridge.tools', bytes(JSON.stringify(listedTools('', false))))
  measured.set('bridge.tools.macAndAddons', bytes(JSON.stringify(listedTools('token', true))))

  measured.set('firstMessage.codex.implementation', bytes(threadPreamble(codexImpl) ?? ''))
  measured.set('firstMessage.codex.chat', bytes(threadPreamble(codexChat) ?? ''))
  measured.set('firstMessage.housePreamble', bytes(HOUSE_PREAMBLE))
})

afterAll(async () => {
  await registry.close()
  cancelMirrors()
  db.close()
  await rm(root, { recursive: true, force: true })
})

function table(): string {
  const rows = [...measured.entries()].map(([part, n]) => {
    const budget = PROMPT_BUDGET[part]
    return `${n > budget ? 'OVER' : '    '}  ${part.padEnd(36)} ${String(n).padStart(7)} of ${String(budget).padStart(7)}`
  })
  return ['The host-written prompt parts, in bytes (src/shared/promptBudget.ts):', ...rows].join('\n')
}

describe('prompt budgets', () => {
  it('measures every budgeted part', () => {
    expect([...measured.keys()].sort()).toEqual(Object.keys(PROMPT_BUDGET).sort())
  })

  it('keeps every part inside its budget', () => {
    const over = [...measured.entries()].filter(([part, n]) => n > PROMPT_BUDGET[part])
    if (over.length) console.log(table())
    expect(over.map(([part]) => part), `${table()}\n\nRaising a budget is a reviewed one-line change with a reason; trimming the text is usually the answer.`).toEqual([])
  })
})
