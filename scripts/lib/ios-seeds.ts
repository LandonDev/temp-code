/**
 * The seeds behind the iOS test server (scripts/ios-client-test-server.ts)
 * and the fixture capture (scripts/capture-swift-fixtures.ts), as pure data:
 * rows, documents, a batch row, a devices report and the canned tool output
 * a fake MacDevices answers with, an accounts snapshot. scripts/ios-seeds.test.ts
 * checks each without booting a server, so a seed a sibling's screen
 * depends on (one row per NoticeKind, one per FailureKind, a seven-milestone
 * project plan, a batch mid-run with a streaming shell step) is proven here.
 */
import type { AccountsSnapshot } from '../../src/shared/accounts'
import { BuildFactsSchema } from '../../src/shared/wireSchemas'
import { FailureKindSchema, type AgentEvent, type FailureKind } from '../../src/shared/events'
import type { BatchRules } from '../../src/shared/contract-batch'
import type { HostDevicesReport } from '../../src/shared/contract-hostdevices'
import type { BuildFacts } from '../../src/shared/deployDrift'
import { emptyNotes } from '../../src/shared/notes'
import { TURN_ENDED_SUMMARY } from '../../src/shared/failureFallback'
import { freshRow, type StoredBatch } from '../../src/main/server/batch'
import type { HolderRow, MacDevicesDeps } from '../../src/main/server/devices/hostDevices'

// ── the preamble stamp ────────────────────────────────────────────────

/** The word count the notices and preamble threads carry; the Swift tests read it. */
export const PREAMBLE_WORDS = 212

/** A brief of exactly PREAMBLE_WORDS words, the shape of a project preamble. */
export function preambleText(): string {
  const lines = [
    'Work in your own git worktree cut from the project branch and symlink the main checkout node_modules into it.',
    'Run the typecheck and the tests you wrote or touched, never the full suite or the build.',
    'Land with the merge tool: it typechecks the branch in a queue and holds the merge on a failure.',
    'When green, fetch origin, rebase onto the project branch, resolve conflicts, then call the merge tool.',
    'Commit messages are plain prose with no attribution trailers of any kind.',
    'Never touch the installed app, never run the box update or the release, never edit the Mac checkout.',
    'Update the docs so they say what is now true, and give every new behaviour a unit test.'
  ]
  const words = lines.join(' ').split(/\s+/)
  while (words.length < PREAMBLE_WORDS) words.push(...'Keep the change small and the diff readable.'.split(' '))
  return words.slice(0, PREAMBLE_WORDS).join(' ')
}

/** The first user row of a thread started in a project with a preamble. */
export function preambleRow(text = 'Add the export button to the billing page.'): AgentEvent {
  return { type: 'user-text', text, preamble: { text: preambleText(), words: PREAMBLE_WORDS }, newPass: true }
}

// ── notices and failures ──────────────────────────────────────────────

/** A 40-line gate log tail that ends the way a red vitest step does. */
export function gateLogTail(): string {
  const lines = Array.from({ length: 39 }, (_, i) => (i % 9 === 8 ? `✓ step ${i} ${i + 2}s` : `  ${i + 1} | const value${i} = ${i}`))
  return [...lines, '✗ vitest 12s'].join('\n')
}

/** One notice row per NoticeKind, in the order a thread meets them: a passed
 *  gate, a failed one, a held review, a passed one, the batch's merge, and
 *  the account that left. */
export function noticeRows(reviewerId = 'ios-notices-reviewer'): AgentEvent[] {
  const at = 1_760_000_000_000
  return [
    {
      type: 'notice',
      kind: 'gate',
      message: 'Typecheck passed on ios/notices',
      gate: { step: 'typecheck', branch: 'ios/notices', ok: true, log: '✓ typecheck 41s', at }
    },
    {
      type: 'notice',
      kind: 'gate',
      message: 'HELD: gate failed on ios/notices · vitest',
      gate: { step: 'gate', branch: 'ios/notices', ok: false, log: gateLogTail(), at: at + 60_000 }
    },
    {
      type: 'notice',
      kind: 'review',
      message: 'Review held: 1 blocking finding (2 minor)',
      review: {
        runId: 'rv1',
        reviewerId,
        provider: 'codex',
        model: 'gpt-6.1-sol',
        outcome: 'held',
        branch: 'ios/notices',
        target: 'master',
        blocking: [
          {
            file: 'src/a.ts',
            line: 12,
            summary: 'The empty list is read before the guard',
            failure_scenario: 'An empty `rows` crashes the fold on first paint',
            verdict: 'CONFIRMED',
            category: 'correctness'
          }
        ],
        minor: [
          { file: 'src/a.ts', line: 30, summary: 'Two sorts where one would do', failure_scenario: '', verdict: 'PLAUSIBLE', category: 'efficiency' },
          { file: 'src/b.ts', line: 4, summary: 'The helper duplicates fold()', failure_scenario: '', verdict: 'PLAUSIBLE', category: 'simplification' }
        ],
        merged: false,
        pushed: false
      }
    },
    {
      type: 'notice',
      kind: 'review',
      message: 'Reviewed by GPT-6.1 Sol: no blocking findings',
      review: {
        runId: 'rv2',
        reviewerId,
        provider: 'codex',
        model: 'gpt-6.1-sol',
        outcome: 'pass',
        branch: 'ios/notices',
        target: 'master',
        blocking: [],
        minor: [],
        merged: true,
        pushed: true
      }
    },
    { type: 'notice', kind: 'batch', message: 'Merged by the batch: ios/x → master at 1a2b3c4d5e, pushed' },
    {
      type: 'notice',
      kind: 'account-gone',
      account: 'ws@example.com',
      message: 'Account ws@example.com is gone from this host; routing automatically from here (10:42)'
    }
  ]
}

const FAILURE_LINES: Record<FailureKind, [summary: string, cause: string]> = {
  oauth_expired: ['work@example.com needs a sign-in', 'the OAuth session lapsed and its refresh was refused'],
  account_unknown: ['The account spare@example.com is no longer on file', 'it was removed from this host'],
  token_expired: ['work@example.com answered 401 token_expired', 'this instance is not the account owner, so nothing refreshed the token'],
  rate_limited: ['work@example.com hit the 5h window', 'the window is spent; it refills in 40 minutes'],
  quota: ['work@example.com has nothing left to spend', 'the plan is out of credits'],
  model_unavailable: ['claude-fable-5-1 is not available here', 'the model is orchestrators-only on this host'],
  network: ['api.anthropic.com could not be reached', 'the socket closed before the first byte'],
  harness_crashed: ['The harness exited mid-turn', 'claude exited with code 137'],
  turn_ended: [TURN_ENDED_SUMMARY, 'the CLI reached its turn limit'],
  unknown: ['The turn failed', 'the harness gave no reason']
}

/** An error row per FailureKind, each with the host's verdict; `rate_limited` names its window. */
export function failureRows(): AgentEvent[] {
  return FailureKindSchema.options.map((kind): AgentEvent => {
    const [summary, cause] = FAILURE_LINES[kind]
    const account = kind === 'unknown' || kind === 'network' || kind === 'harness_crashed' || kind === 'turn_ended' ? null : 'work@example.com'
    return {
      type: 'error',
      message: `${summary}: ${cause}`,
      ...(kind === 'rate_limited' ? { limit: { window: '5h' as const } } : {}),
      failure: { kind, account, summary, cause }
    }
  })
}

/** The notices thread whole: the preamble row, every notice, every failure, the clear, a plan hand-off, the error status. */
export function noticesThreadRows(buildId = 'ios-master-impl-b'): AgentEvent[] {
  return [
    preambleRow('Land the notices thread with every card the phone draws.'),
    { type: 'status', status: 'running' },
    ...noticeRows(),
    ...failureRows(),
    { type: 'errors-cleared' },
    { type: 'plan-handoff', sessionId: buildId, title: 'Backfill the rollups', how: 'auto' },
    { type: 'status', status: 'error' }
  ]
}

// ── notes ─────────────────────────────────────────────────────────────

/** Every section filled: Goal two lines, Decisions three, State with a first-line status, Pointers with a file and a command, Open questions one. */
export function notesFive(): string {
  return [
    '## Goal',
    '',
    'Put the thread notes on the phone: the drawer, the State line on the banner, the search icon.',
    'One screen, read-only until the operate key lands.',
    '',
    '## Decisions',
    '',
    '- The drawer reads the `notes` push; no polling.',
    '- Markdown through the client package cache, off the main actor.',
    '- Edit lands later, behind the operate key.',
    '',
    '## State',
    '',
    'Drawer built; the banner line next.',
    'Done: the store on the push. In flight: the banner. Blocked: nothing.',
    '',
    '## Pointers',
    '',
    '- ios/TempCode/Sources/Thread/NotesDrawer.swift',
    '- `bun run ios:test:client --filter NotesTests`',
    '',
    '## Open questions',
    '',
    '- Does the search icon show on a thread with empty notes? (for the designer)',
    ''
  ].join('\n')
}

/** Only Goal and State filled; the other headings present and empty. */
export function notesTwo(): string {
  return [
    '## Goal',
    '',
    'Say what the thread is for in two lines.',
    '',
    '## Decisions',
    '',
    '## State',
    '',
    'Just started.',
    '',
    '## Pointers',
    '',
    '## Open questions',
    ''
  ].join('\n')
}

/** The five headings with nothing under them: a thread that never wrote notes. */
export const notesEmptyDoc = emptyNotes

// ── the project plan ──────────────────────────────────────────────────

const MILESTONES: [title: string, done: boolean][] = [
  ['Design foundations', true],
  ['Home and the rail', true],
  ['The transcript', true],
  ['Search across hosts', false],
  ['The thread screens', false],
  ['Steering', false],
  ['Push and the Live Activity', false]
]

/** A complete project plan: every fixed section, `status: complete`, seven milestones, three ticked. */
export function projectPlanMarkdown(): string {
  const milestones = MILESTONES.flatMap(([title, done], i) => [
    `### [${done ? 'x' : ' '}] ${i + 1}. ${title}`,
    '',
    `- Scope: ${title} on the phone, to the design doc.`,
    `- Dependencies: ${i === 0 ? 'none' : `milestone ${i}`}`,
    `- Done when: the ${title.toLowerCase()} screens pass the simulator proof.`,
    ''
  ])
  return [
    '---',
    'status: complete',
    'completedAt: 2026-10-22T09:00:00.000Z',
    '---',
    '# The iOS app',
    '',
    '## Goals',
    '',
    'A phone client that reads every host and steers a thread.',
    '',
    '## Current state',
    '',
    'The contract package and the client runtime exist; the screens are the work.',
    '',
    '## Milestones',
    '',
    ...milestones,
    '## Risks',
    '',
    '- Swift does not compile on the box; the Mac proves every build.',
    '',
    '## Open questions',
    '',
    '- Which iOS version is the floor? (for the owner)',
    ''
  ].join('\n')
}

// ── the batch row ─────────────────────────────────────────────────────

/** The rules the master wrote: land, gate, release, then a smoke test. */
export function batchRulesWithSmoke(): BatchRules {
  return {
    land: 'as-they-finish',
    steps: [
      { id: 'land', name: 'Land', kind: 'land' },
      { id: 'gate', name: 'Gate', kind: 'gate' },
      { id: 'release', name: 'Release', kind: 'release' },
      { id: 'smoke', name: 'Smoke test', kind: 'shell', run: 'bun run smoke', when: 'all-done' }
    ],
    then: 'notify',
    summary: 'Land as they finish, gate once, release, then the smoke test'
  }
}

/** The lines a shell step shows while it runs: `$ <run>` first, then output. */
export function smokeLog(lines = 40): string[] {
  return ['$ bun run smoke', ...Array.from({ length: lines - 1 }, (_, i) => `smoke ${String(i + 1).padStart(2, '0')}: ${i % 5 === 4 ? 'ok' : 'checking the billing page'}`)]
}

/**
 * A batch mid-run: land passed (the done children landed), the gate running
 * at 2 of 3 with vitest as the label, the release pending, the shell step
 * running with a 40-line log ending in `$ bun run smoke` (the newest lines
 * are the step's last; the seed's log opens with the command so the console
 * shows it). `landed` names the done children; `held` is empty.
 */
export function batchRowMidRun(masterId: string, children: { landed: string[]; pending: string[] }, now = 1_760_000_000_000): StoredBatch {
  const row = freshRow(masterId, batchRulesWithSmoke())
  const total = children.landed.length + children.pending.length
  row.steps = row.steps.map((step) => {
    switch (step.id) {
      case 'land':
        return { ...step, status: 'passed', detail: `${children.landed.length} of ${total} branches landed`, at: now - 120_000, startedAt: now - 130_000, endedAt: now - 120_000, progress: { done: children.landed.length, total } }
      case 'gate':
        return { ...step, status: 'running', detail: 'vitest', at: now - 60_000, startedAt: now - 60_000, progress: { done: 2, total: 3, label: 'vitest' }, log: ['✓ typecheck 41s', '✓ build 58s'] }
      case 'smoke':
        return { ...step, status: 'running', detail: '', at: now - 5_000, startedAt: now - 5_000, log: smokeLog() }
      default:
        return step
    }
  })
  row.landed = [...children.landed]
  row.branches = Object.fromEntries(children.landed.map((id) => [id, `ios/${id}`]))
  row.subjects = Object.fromEntries(children.landed.map((id) => [id, [`${id}: landed`]]))
  row.armed = false
  return row
}

/** The row with more lines on its running shell step (the control panel's /batch-log). */
export function withShellLog(row: StoredBatch, lines: string[]): StoredBatch {
  return {
    ...row,
    steps: row.steps.map((step) => (step.kind === 'shell' && step.status === 'running' ? { ...step, log: [...step.log, ...lines].slice(-200) } : step))
  }
}

// ── devices on a Mac ──────────────────────────────────────────────────

export const SIMULATOR_BOOTED = '11111111-AAAA-4BBB-8CCC-000000000001'
export const SIMULATOR_SHUTDOWN = '22222222-AAAA-4BBB-8CCC-000000000002'
export const PHONE_UDID = '00008140-001A2B3C4D5E6F70'
export const XCODE_APP = '/Applications/Xcode-26.app'

/** What `xcrun simctl list -j devices` prints for two iPhone 17 simulators on iOS 26. */
export function simctlJson(): string {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
        { udid: SIMULATOR_BOOTED, name: 'iPhone 17', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
        { udid: SIMULATOR_SHUTDOWN, name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }
      ],
      'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': []
    }
  })
}

/** What `xcrun devicectl list devices --json-output` writes for one paired iPhone. */
export function devicectlJson(): string {
  return JSON.stringify({
    info: { arguments: ['devicectl', 'list', 'devices'], outcome: 'success' },
    result: {
      devices: [
        {
          identifier: 'F1E2D3C4-0000-4000-8000-00000000ABCD',
          hardwareProperties: { udid: PHONE_UDID, deviceType: 'iPhone', platform: 'iOS', marketingName: 'iPhone 16 Pro', productType: 'iPhone17,1' },
          deviceProperties: { name: 'Landon’s iPhone', osVersionNumber: '26.0' },
          connectionProperties: { pairingState: 'paired', tunnelState: 'disconnected', transportType: 'localNetwork' }
        }
      ]
    }
  })
}

/** `ps -axo pid,pcpu,command` with the booted simulator's processes. */
export function psOutput(): string {
  return [
    '  PID %CPU COMMAND',
    `  412  8.3 /Library/Developer/CoreSimulator/Volumes/iOS_26/Devices/${SIMULATOR_BOOTED}/data/Containers/Bundle/Application/TempCode.app/TempCode`,
    `  418  4.2 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim -d /Users/x/Library/Developer/CoreSimulator/Devices/${SIMULATOR_BOOTED}/data`,
    '  500  0.1 /usr/libexec/trustd'
  ].join('\n')
}

/**
 * The deps of a `MacDevices` that runs nothing: the runner answers simctl,
 * devicectl (through the temp file `readFile` serves) and ps with the canned
 * output above, the Xcode is Xcode-26 with its version plist, the load 3.2 on
 * 8 cores. `ledger` names the thread that holds the booted simulator.
 */
export function fakeMacDevicesDeps(environmentId: string, opts: { ledger?: HolderRow[]; session?: MacDevicesDeps['session']; now?: () => number } = {}): MacDevicesDeps {
  const DEVICES_JSON = '/fake/devicectl/devices.json'
  return {
    environmentId,
    env: {},
    run: async (file, args) => {
      if (file === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') return { stdout: simctlJson(), stderr: '' }
      if (file === 'xcrun' && args[0] === 'devicectl') return { stdout: '', stderr: '' }
      if (file === 'ps') return { stdout: psOutput(), stderr: '' }
      if (file === 'open') return { stdout: '', stderr: '' }
      throw new Error(`fake devices: no answer for ${file} ${args.join(' ')}`)
    },
    listXcodes: () => [XCODE_APP],
    readFile: (path) => {
      if (path === DEVICES_JSON) return devicectlJson()
      if (path === `${XCODE_APP}/Contents/version.plist`)
        return '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>26.0</string></dict></plist>'
      return null
    },
    tempJson: () => ({ path: DEVICES_JSON, done: () => {} }),
    loadavg: () => 3.2,
    cores: () => 8,
    ledger: () => opts.ledger ?? [{ sessionId: 'ios-resources', identifier: SIMULATOR_BOOTED, label: 'iPhone 17' }],
    session: opts.session ?? ((id) => (id === 'ios-resources' ? { title: 'The resources thread', status: 'idle' } : null)),
    now: opts.now ?? (() => 1_760_000_000_000),
    log: () => {}
  }
}

/** The report the fake gatherer answers with, hand-written: what a Swift decoder test and a screen can read without the gatherer. */
export function devicesReport(environmentId: string, at = 1_760_000_000_000): HostDevicesReport {
  return {
    environmentId,
    at,
    simulators: [
      { udid: SIMULATOR_BOOTED, name: 'iPhone 17', runtime: 'iOS 26.0', state: 'booted', cpu: 12.5, holder: { sessionId: 'ios-resources', title: 'The resources thread', status: 'idle' } },
      { udid: SIMULATOR_SHUTDOWN, name: 'iPhone 17 Pro', runtime: 'iOS 26.0', state: 'shutdown', holder: null }
    ],
    phones: [{ udid: PHONE_UDID, name: 'Landon’s iPhone', model: 'iPhone 16 Pro', os: 'iOS 26.0', connection: 'paired', transport: 'Wi-Fi', holder: null }],
    xcode: { path: XCODE_APP, name: 'Xcode-26', version: '26.0', from: 'newest' },
    load: { oneMinute: 3.2, cores: 8 },
    problems: []
  }
}

// ── accounts ──────────────────────────────────────────────────────────

export const PINNED_ACCOUNT = 'work@example.com'
export const SPARE_ACCOUNT = 'spare@example.com'

/**
 * Two Claude profiles with different headroom (work: room 0.8, 12/min, the
 * 5h window at 40%; spare: room 0.1, throttled for ten minutes, the weekly
 * window at 95%), work pinned; one Codex profile; the second host as a
 * connected peer synced five minutes ago with its build.
 */
export function accountsSnapshot(peer: { environmentId: string; name: string; build: BuildFacts | null }, now = 1_760_000_000_000): AccountsSnapshot {
  const build = peer.build ? BuildFactsSchema.parse(peer.build) : null
  return {
    updatedAt: now,
    providers: {
      claude: {
        pinned: PINNED_ACCOUNT,
        profiles: [
          { name: PINNED_ACCOUNT, email: PINNED_ACCOUNT, nickname: 'Work', color: '#2f6fed', createdAt: now - 90 * 86_400_000, lastActivatedAt: now - 3_600_000, active: true, activeOn: ['CLI', 'App'] },
          { name: SPARE_ACCOUNT, email: SPARE_ACCOUNT, createdAt: now - 30 * 86_400_000, active: false, static: true, expiresAt: now + 300 * 86_400_000 }
        ],
        reports: [
          {
            profileName: PINNED_ACCOUNT,
            windows: [
              { label: '5h', usedPercent: 40, resetsAt: now + 2_400_000, periodMs: 18_000_000 },
              { label: 'Weekly', usedPercent: 22, resetsAt: now + 3 * 86_400_000, periodMs: 7 * 86_400_000 }
            ],
            plan: { name: 'Max 20x', monthlyUsd: 200, renewsAt: now + 12 * 86_400_000, anchorDay: 3 }
          },
          {
            profileName: SPARE_ACCOUNT,
            windows: [
              { label: '5h', usedPercent: 100, resetsAt: now + 600_000, periodMs: 18_000_000 },
              { label: 'Weekly', usedPercent: 95, resetsAt: now + 86_400_000, periodMs: 7 * 86_400_000 }
            ],
            note: 'rate limited',
            rateLimit: { provider: 'anthropic', until: now + 600_000 },
            plan: { name: 'Max 5x', monthlyUsd: 100 }
          }
        ],
        owner: 'temp-code',
        headroom: {
          [PINNED_ACCOUNT]: { room: 0.8, resetsAt: now + 60_000, ratePerMin: 12, tier: 'allowed', seenAt: now - 5_000 },
          [SPARE_ACCOUNT]: { room: 0.1, throttledUntil: now + 600_000, ratePerMin: 0, tier: 'allowed_warning', seenAt: now - 120_000 }
        }
      },
      codex: {
        pinned: null,
        profiles: [{ name: 'codex@example.com', email: 'codex@example.com', createdAt: now - 10 * 86_400_000, active: true }],
        reports: [{ profileName: 'codex@example.com', windows: [{ label: '5h', usedPercent: 12 }], banked: 2 }],
        owner: 'temp-code'
      },
      cursor: { pinned: null, profiles: [], reports: [], owner: null, note: 'not signed in' }
    },
    peers: {
      [peer.environmentId]: { name: peer.name, connected: true, lastSyncAt: now - 300_000, error: null, build }
    }
  }
}
