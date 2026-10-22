import { describe, expect, it } from 'vitest'
import type { AccountsSnapshot } from './accounts'
import type { SessionBatchResult, ThreadNotesDoc } from './contract'
import type { SessionChanges } from './wire'
import type { BatchState } from './contract-batch'
import type { DeployStatus, HostJobStatus, HostLogPush } from './contract-host'
import type { HostDevicesHost, HostDevicesReport } from './contract-hostdevices'
import type { MacBridgeThreadState } from './contract-macbridge'
import { ProjectPlanTickAnswerSchema, type ProjectPlanState } from './contract-projectplan'
import type { ThreadResource, ThreadResourceRemoval } from './contract-resources'
import type { BuildFacts } from './deployDrift'
import { NoticeKindSchema, type AgentEvent, type SessionMeta } from './events'
import * as W from './wireSchemas'

// Every schema the 2026-10-21/22 features added parses a value typed by its
// interface and gives it back unchanged: the type-level pins prove the keys,
// this proves the runtime constraints (int, enum, nullable) admit real values.

const meta: SessionMeta = {
  id: 'ios-master-impl-a',
  parentId: null,
  projectId: 'p',
  workspaceId: 'ws',
  threadType: 'implementation',
  planPath: null,
  provider: 'claude',
  model: 'claude-haiku-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  title: 'A child',
  cwd: '/tmp/p',
  status: 'done',
  pinned: false,
  archived: false,
  permission: 'edits',
  fast: false,
  ultrafast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  nativeId: null,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_001,
  masterId: 'ios-master',
  startedBy: 'ios-master'
} as SessionMeta

const build: BuildFacts = { release: 400, version: '1.0.400', sha: 'abc123', platform: 'linux' }

const batch: BatchState = {
  masterId: 'ios-master',
  rules: {
    land: 'as-they-finish',
    steps: [
      { id: 'land', name: 'Land', kind: 'land' },
      { id: 'gate', name: 'Gate', kind: 'gate' },
      { id: 'smoke', name: 'Smoke test', kind: 'shell', run: 'bun run smoke', when: 'all-done' }
    ],
    then: 'notify',
    summary: 'Land as they finish, gate, smoke'
  },
  steps: [
    { id: 'land', name: 'Land', kind: 'land', status: 'passed', detail: '3 of 4 branches landed', at: 1, progress: { done: 3, total: 4 }, log: [] },
    { id: 'gate', name: 'Gate', kind: 'gate', status: 'running', detail: '', at: 2, startedAt: 2, progress: { done: 2, total: 3, label: 'vitest' }, log: ['✓ typecheck 12s'] },
    { id: 'smoke', name: 'Smoke test', kind: 'shell', status: 'pending', detail: '', at: null, log: [] }
  ],
  landed: ['ios-master-impl-a'],
  pending: ['ios-master-impl-b'],
  held: [],
  blocked: null,
  finishedAt: null
}

const resource: ThreadResource = {
  id: 'r1',
  sessionId: 'ios-resources',
  environmentId: 'env_a',
  kind: 'worktree',
  identifier: '/tmp/p/.claude/worktrees/x',
  label: 'x',
  branch: 'x',
  createdAt: 1_760_000_000_000,
  removeRequestedAt: null,
  removedAt: null,
  note: null
}

const report: HostDevicesReport = {
  environmentId: 'env_a',
  at: 1_760_000_000_000,
  simulators: [
    { udid: 'A-1', name: 'iPhone 17', runtime: 'iOS 26.0', state: 'booted', cpu: 12.5, holder: { sessionId: 'ios-resources', title: 'Resources', status: 'idle' } },
    { udid: 'A-2', name: 'iPhone 17 Pro', runtime: 'iOS 26.0', state: 'shutdown', holder: null }
  ],
  phones: [{ udid: 'P-1', name: "Landon's iPhone", model: 'iPhone 16 Pro', os: 'iOS 26.0', connection: 'paired', holder: null }],
  xcode: { path: '/Applications/Xcode-26.app', name: 'Xcode-26', version: '26.0', from: 'newest' },
  load: { oneMinute: 3.2, cores: 8 },
  problems: []
}

const snapshot: AccountsSnapshot = {
  updatedAt: 1_760_000_000_000,
  providers: {
    claude: {
      pinned: 'work@example.com',
      profiles: [{ name: 'work@example.com', email: 'work@example.com', createdAt: 1_750_000_000_000, active: true, activeOn: ['CLI'] }],
      reports: [
        {
          profileName: 'work@example.com',
          windows: [{ label: '5h', usedPercent: 40, resetsAt: 1_760_000_100_000, periodMs: 18_000_000 }],
          plan: { name: 'Max 20x', monthlyUsd: 200 },
          rateLimit: { provider: 'anthropic' }
        }
      ],
      owner: 'temp-code',
      mint: { rows: { 'work@example.com': { state: 'minting', at: 1 } }, run: { total: 1, done: 0 } },
      headroom: { 'work@example.com': { room: 0.8, ratePerMin: 12, seenAt: 1_760_000_000_000 } }
    },
    codex: { pinned: null, profiles: [], reports: [], owner: null },
    cursor: { pinned: null, profiles: [], reports: [], owner: null, note: 'vault locked' }
  },
  homes: { claude: 'env_b' },
  peers: { env_b: { name: 'The box', connected: true, lastSyncAt: 1_759_999_700_000, error: null, build } }
}

const parses = <T>(schema: { parse: (v: unknown) => unknown }, value: T): void => {
  expect(schema.parse(value)).toEqual(value)
}

describe('the master thread shapes', () => {
  it('parse', () => {
    const result: SessionBatchResult = { attempted: ['a', 'b'], succeeded: ['a'], failed: [{ sessionId: 'b', error: 'gone' }] }
    parses(W.SessionBatchResultSchema, result)
    parses(W.SessionStartedSchema, { started: false })
    parses(W.BatchChildrenSchema, { children: [meta] })
    parses(W.BatchStoppedSchema, { stopped: true })
    parses(W.BatchPushSchema, { push: 'batch', state: batch })
  })
})

describe('notes, plans, reviews and resources', () => {
  it('parse the notes doc and its push', () => {
    const doc: ThreadNotesDoc = { text: '## Goal\n', updatedAt: 1_760_000_000_000, path: '/tmp/p/.temp-code/attachments/s/notes.md' }
    parses(W.ThreadNotesDocSchema, doc)
    parses(W.ThreadNotesDocSchema, { text: '', updatedAt: null, path: null })
    parses(W.NotesPushSchema, { push: 'notes', sessionId: 's', doc })
  })
  it('parse the project plan tick', () => {
    const state: ProjectPlanState = {
      projectId: 'p',
      path: '/tmp/p/.temp-code/plans/project.md',
      exists: true,
      pinned: true,
      sessionId: 'ios-project-plan',
      complete: true,
      milestones: [{ index: 1, title: 'Tokens', done: true }],
      missing: []
    }
    parses(ProjectPlanTickAnswerSchema, { ticked: true, state })
    parses(ProjectPlanTickAnswerSchema, { ticked: false, state: null })
  })
  it('parse the resource rows, their removal and their push', () => {
    parses(W.ThreadResourceSchema, resource)
    const waiting: ThreadResource = { ...resource, id: 'r2', kind: 'simulator', identifier: 'A-1', branch: null, removeRequestedAt: 2, note: 'Mac offline, waiting' }
    parses(W.ResourcesListSchema, { resources: [resource, waiting] })
    const removal: ThreadResourceRemoval = { id: 'r1', outcome: 'waiting', note: 'Mac offline, waiting' }
    parses(W.ResourcesRemovedSchema, { results: [removal] })
    parses(W.ResourcesPushSchema, { push: 'resources', sessionId: 'ios-resources', resources: [resource] })
    expect(() => W.ThreadResourceSchema.parse({ ...resource, kind: 'container' })).toThrow()
  })
})

describe('the launch mirror, the restart ledger', () => {
  it('parse both session.changes answers', () => {
    const reset: SessionChanges = { reset: true, seq: 12, generation: 'g1' }
    parses(W.SessionChangesSchema, reset)
    const full: SessionChanges = { reset: false, seq: 13, generation: 'g1', sessions: [meta], removed: ['gone'] }
    parses(W.SessionChangesSchema, full)
  })
  it('parse the boot-resume push', () => {
    parses(W.BootResumePushSchema, { push: 'boot-resume', count: 4, at: 1_760_000_000_000 })
    expect(() => W.BootResumePushSchema.parse({ push: 'boot-resume', count: 1.5, at: 1 })).toThrow()
  })
})

describe('devices, deploy, the bridge, accounts', () => {
  it('parse the device hosts, the report, the answers and the push', () => {
    const host: HostDevicesHost = { environmentId: 'env_a', name: 'Landon’s Mac', local: true }
    parses(W.HostDevicesHostSchema, host)
    parses(W.HostDevicesOkSchema, { ok: true })
    parses(W.HostDeviceOpenedSchema, { ok: true, opened: 'xcode' })
    parses(W.HostDevicesPushSchema, { push: 'host.devices', report })
  })
  it('parse the deploy status, the log snapshot and the log push', () => {
    const status: HostJobStatus = { job: 'deploy', phase: 'idle', target: null, startedAt: null, finishedAt: null, exit: null, stoppable: false }
    parses(W.HostJobStatusSchema, status)
    const deploy: DeployStatus = { ...status, job: 'deploy', installed: false, installHint: 'sudo install-deploy-trigger', version: '1.0.400' }
    parses(W.DeployStatusSchema, deploy)
    parses(W.HostLogSnapshotSchema, { text: '', status })
    const push: HostLogPush = { push: 'host-log', job: 'deploy', append: 'line\n', status }
    parses(W.HostLogPushSchema, push)
    expect(() => W.DeployStatusSchema.parse({ ...deploy, job: 'publish' })).toThrow()
  })
  it('parse the bridge thread state and the held push', () => {
    const state: MacBridgeThreadState = { sessionId: 's', macPeer: null, inherited: false, online: false, registered: [] }
    parses(W.MacBridgeThreadStateSchema, state)
    parses(W.MacBridgeThreadStateSchema, { ...state, macPeer: 'env_m', online: true, registered: ['env_m'], held: 3 })
    parses(W.MacBridgeHeldPushSchema, { push: 'macBridge.held', sessionId: 's', held: 3 })
  })
  it('parse the accounts snapshot (the phone's subset) and its push', () => {
    // The snapshot schema is a subset of the desktop's (thread 24): it parses
    // the whole snapshot and keeps the fields the phone reads.
    const parsed = W.AccountsSnapshotSchema.parse(snapshot)
    expect(parsed.providers.claude.headroom?.['work@example.com']?.room).toBe(0.8)
    expect(parsed.providers.claude.profiles[0]?.name).toBe('work@example.com')
    expect(W.AccountsPushSchema.parse({ push: 'accounts', snapshot }).snapshot.updatedAt).toBe(snapshot.updatedAt)
    parses(W.BuildFactsSchema, build)
  })
})

describe('the notice kinds', () => {
  it('are the literals the server appends', () => {
    expect(NoticeKindSchema.options).toEqual(['review', 'gate', 'batch', 'account-gone'])
    const kinds: AgentEvent[] = [
      { type: 'notice', kind: 'review', message: 'Reviewed' },
      { type: 'notice', kind: 'gate', message: 'Gate passed' },
      { type: 'notice', kind: 'batch', message: 'Merged by the batch' },
      { type: 'notice', kind: 'account-gone', message: 'Account gone', account: 'ws@example.com' }
    ]
    for (const row of kinds) expect(W.WireAgentEventSchema.parse(row)).toEqual(row)
    expect(() => W.WireAgentEventSchema.parse({ type: 'notice', kind: 'weather', message: 'Rain' })).toThrow()
  })
  it('every remote push has its own schema in the union, once', () => {
    const names = W.RemotePushSchema.options.map((o) => o.shape.push.value)
    expect(names).toEqual(expect.arrayContaining(['notes', 'batch', 'resources', 'boot-resume', 'accounts', 'host.devices', 'host-log', 'macBridge.held']))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('session.changes on the wire (thread 14)', () => {
  it('parses the reset answer and the delta answer with one flat schema', () => {
    const reset = W.SessionChangesSchema.parse({ reset: true, seq: 12, generation: 'g1' })
    expect(reset).toEqual({ reset: true, seq: 12, generation: 'g1' })
    const delta = W.SessionChangesSchema.parse({ reset: false, seq: 13, generation: 'g1', sessions: [], removed: ['s9'] })
    expect(delta.sessions).toEqual([])
    expect(delta.removed).toEqual(['s9'])
    expect(() => W.SessionChangesSchema.parse({ reset: false, seq: 1.5, generation: 'g1' })).toThrow()
  })
  it('the boot-resume push is a remote push with its count and the boot time', () => {
    const frame = { push: 'boot-resume', count: 3, at: 1_700_000_000_000 }
    expect(W.RemotePushSchema.parse(frame)).toEqual(frame)
    expect(() => W.RemotePushSchema.parse({ push: 'boot-resume', count: 3 })).toThrow()
  })
})
