# TempCodeContract

The wire types of temp-code's remote profile as a Swift package: `Codable`
value types generated from the server's zod contract, with fixtures captured
from a real server proving that Swift decodes exactly what the server sends.
No UI, no networking. L2 (the socket actor, the cache, the read-only client)
builds on this.

## What is here

- `Sources/TempCodeContract/Generated/` — generated, do not edit.
  `Enums.swift` (the literal unions), `Types.swift` (sessions, projects,
  workspaces, bodies, remote keys, the HTTP bodies), `AgentEvent.swift`
  (every row kind), `ServerPush.swift` (every push a remote socket gets),
  `Methods.swift` (one type per request method with `Params`, `Output` and
  the wire `name`), `Contract.swift` (`contractVersion`, what the server
  sends in `hello.contract`).
- `JSONValue.swift` — any JSON value, for `unknown` slots, for the unknown
  case of every union, and for canonical comparison in tests.
- `Framing.swift` — `Request<M>` (`{ id, method, params }`), `Response`
  (`{ id, ok, result | error }`), `ServerFrame` with `decodeFrame(_:)` that
  tells a push from a response, `ContractMethod`, `NoParams`, `NoOutput`,
  `Patch<T>`.
- `Tests/Fixtures/*.json` — frames and HTTP bodies recorded from a real
  server; `Tests/TempCodeContractTests/FixtureTests.swift` decodes each one,
  encodes it again and compares canonical JSON. Besides the first set
  (hello, the lists, the events tail, the pushes, the searches, the inbox)
  the capture records `batch-get`, `batch-children`, `push-batch`,
  `session-notes-get`, `push-notes`, `project-plan-get`,
  `project-plan-get-null`, `project-plan-link-of`, `review-get`, `plans-get`,
  `resources-list`, `push-resources`, `session-changes`,
  `session-changes-reset`, `session-events-notices` (a notice of every
  `NoticeKind`, an error row per `FailureKind`, the preamble stamp and a
  `plan-handoff`), `notes-search`, `session-start`, `session-batch`,
  `host-devices-hosts`, `host-deploy-status`, `host-log`,
  `mac-bridge-thread-get`, `accounts-list`, `push-boot-resume` and
  `push-accounts`, from the seeds in `scripts/lib/ios-seeds.ts`.
  `DecoderRulesTests.swift` proves the decoder's rules on hand-written JSON
  and needs no fixture.

## Regenerating

```sh
bun run gen:swift              # writes Generated/
bun run check:swift-contract   # regenerates to a temp dir and diffs; part of `bun run typecheck`
bun run ios:test               # swift build + swift test for this package
bun run script:capture-swift-fixtures   # re-records Tests/Fixtures from a real server
```

`check:swift-contract` runs inside `bun run typecheck`, which the release
gate runs, so a change to the contract without a regenerate fails the gate.
`swift test` is not in the gate; L2 runs `bun run ios:test` (about five
seconds warm, under a minute cold). On this Mac the Command Line Tools'
`swift-package` is missing a framework, so `scripts/ios-test.sh` runs the
build with the newest `/Applications/Xcode*.app` when `xcode-select -p` is
the CLT; `xcode-select -s` on an Xcode makes that moot.

## The subset

`SUBSET` in `scripts/gen-swift-contract.ts` is the one list of what the phone
speaks: the hello frame and the remote pushes, every row kind, the named
types below, the HTTP bodies of pairing, and these methods. The capability
column is what a client key needs for the call (`src/shared/capabilities.ts`
`METHOD_CAPABILITY`): a read key sees everything in the first group and gets
`forbidden` on the rest, so a screen shows the control disabled instead of
sending. A method whose capability is `local` (the renderer's loopback
socket only: `mac.*`, `macBridge.policy.*`, `macBridge.decide`,
`host.publish*`, `session.move`, `app.*`, `remote.environments.*`,
`deploy.master`) is refused by the generator: `jsonSchemas()` throws
`<method> is local-only (capabilities.ts); a phone can never call it`.

| Method | Answer (`Methods.<Name>.Output`) | Capability |
|---|---|---|
| `catalog.get` | `Catalog` (`[String: ProviderInfo]`) | read |
| `workspace.list`, `project.list` | `[WorkspaceMeta]`, `[ProjectMeta]` | read |
| `project.changes`, `project.diff` | `[FileChange]`, `String` | read |
| `workspace.icon` | `WorkspaceIcon` | read |
| `fs.media`, `file.read` | `FsMedia?`, `String?` | read |
| `session.list`, `session.events`, `session.rowBody` | `SessionPage`, `EventsPage`, `{ row }` | read |
| `session.changes` | `SessionChanges` (the launch mirror's reconcile; `reset` leaves both lists out) | read |
| `session.search`, `search.project`, `notes.search` | `SessionSearchResult`, `ProjectSearchResult`, `NoteSearchResult` | read |
| `session.subscribe`, `session.unsubscribe` | none | read |
| `session.send`, `session.interrupt`, `session.answer`, `session.continue` | none | operate |
| `session.reroute` | `RerouteAnswer` | operate |
| `session.approve`, `session.permission` | none | approve |
| `session.create` | `SessionMeta` (`masterId`, `after`, `queue` in the params) | operate (`permission: 'auto'` needs approve) |
| `session.rename`, `session.archive` (`removeResources`), `session.pin`, `session.pause`, `session.resume` | none | operate |
| `session.start` | `{ started }` (a queued root past its `after`) | operate |
| `session.batch` | `SessionBatchResult` (the fleet switches) | operate |
| `session.setMaster` | none | **admin** (a phone key below admin shows the control disabled) |
| `session.notes.get`, `session.notes.set` | `ThreadNotesDoc` | read, operate |
| `queue.list`, `queue.add`, `queue.remove`, `queue.update`, `queue.reorder`, `queue.steer` | `[QueuedMessage]`, none | read, operate |
| `batch.get`, `batch.children` | `BatchState`, `{ children: [SessionMeta] }` | read |
| `batch.setRules`, `batch.stopStep`, `batch.adopt`, `batch.archive` | `BatchState`, `{ stopped }`, `BatchAdoptResult`, `SessionBatchResult` | operate |
| `projectPlan.get`, `projectPlan.linkOf` | `ProjectPlanState?`, `MilestoneLink?` | read |
| `projectPlan.pin`, `projectPlan.tick`, `projectPlan.link` | `ProjectPlanState?`, `ProjectPlanTickAnswer` (`{ ticked, state }`), none | operate |
| `review.get` | `ReviewScope` | read |
| `review.set` | none | **admin** |
| `review.override` | `ReviewOverrideAnswer` (`{ sha, merged, pushed }`) | approve |
| `plans.get` | `PlanScope` | read |
| `plans.set`, `project.setPreamble`, `workspace.setPreamble` | none | **admin** |
| `plan.implement` | `SessionMeta` | operate |
| `resources.list`, `resources.listAll` | `{ resources: [ThreadResource] }` | read |
| `resources.remove` | `{ results: [ThreadResourceRemoval] }` | operate |
| `host.devices.hosts`, `host.devices`, `host.devices.watch`, `host.devices.unwatch` | `[HostDevicesHost]`, `HostDevicesReport`, `HostDevicesReport`, `{ ok }` | read |
| `host.simulator.shutdown`, `host.simulator.delete`, `host.device.openXcode` | `HostDevicesReport`, `HostDevicesReport`, `{ ok, opened }` | operate |
| `host.deployStatus`, `host.deploy`, `host.log` | `DeployStatus`, `DeployStatus`, `HostLogSnapshot` | **admin** |
| `macBridge.thread.get` | `MacBridgeThreadState` (`held` is the paused count) | read |
| `accounts.list` | `AccountsSnapshot` (the phone's subset: profiles, reports, headroom) | read |
| `attachment.begin`, `attachment.chunk`, `attachment.commit`, `attachment.abort`, `attachment.settings` | the attachment answers | operate (settings: read) |
| `remote.status`, `remote.keys.*`, `remote.pairings.*`, `remote.sessions.*`, `remote.settings.set` | the remote-access rows | admin |
| `remote.push.register`, `remote.push.unregister`, `remote.push.status`, `remote.push.activity` | `PushStatus`, none | read |
| `github.inbox`, `github.inboxRefresh`, `github.details`, `github.thread`, `github.prDiff` | the inbox and work-item shapes | read |

The pushes (`ServerPush`, one case each, `.unknown(JSONValue)` for the rest):
`hello`, `workspaces`, `projects`, `events`, `sessions`, `live-edits`,
`builds`, `queue`, `session-removed`, `session-moved`, `notes` (`{ sessionId,
doc }`), `batch` (`{ state: BatchState }`), `resources` (`{ sessionId,
resources }`), `boot-resume` (`{ count, at }`, once per boot and after
hello), `accounts` (`{ snapshot }`), `host.devices` (`{ report }`, to a
socket with a watch), `host-log` (`{ job, append?, reset?, status }`, to a
socket that asked for the log), `macBridge.held` (`{ sessionId, held }`).
Out by rule, absorbed by `.unknown`: the singular `event`, `session`,
`live-edit` and `build` frames (local sockets), `deploy-master`,
`release-available`, `account`, `accounts-removed`, `memory.nudge`,
`peer.call` (peer links), `macBridge.request`, `macBridge.resolved` (the
Mac's own renderer), `file-event`, `sync`.

To cover another method: add a `method('x.y', OutputSchema)` line (params
come from `src/shared/contract.ts` by name; the output schema lives in
`src/shared/wireSchemas.ts`, where every server → client shape is zod and
pinned to its TypeScript interface by a type-level check), run
`bun run gen:swift`, commit `Generated/`. A new push or named type is a
`union(...)` or `type(...)` line the same way. `scripts/gen-swift-contract.test.ts`
pins the rules below and the names above.

## How the wire maps to Swift

- An object is a `struct` with `let` fields and a public memberwise
  initializer; anonymous objects nest in their parent (`SessionMeta.Tasks`,
  `ToolPreview.Line`).
- A literal union is an enum backed by `String` with an `unknown(String)`
  case (`SessionStatus`, `Capability`, `ProviderId`, …). `rawValue` keeps
  the unknown text, so the value re-encodes as received. When one of the
  union's own literals is `unknown` (`FailureKind`), the fallback case is
  `unrecognized(String)` instead, since Swift refuses two cases of one name.
- A discriminated union is an enum with associated values and an
  `unknown(JSONValue)` case: `AgentEvent` on `type`, `ServerPush` on `push`.
  The payload types (`ToolResultEvent`, `EventsPush`, …) do not carry the
  tag; the enum writes it.
- A plain union (`Body` = text or `OmittedBody`, `LimitWindow`) decodes by
  trying each branch in order, with `unknown(JSONValue)` last.
- `.optional()` is `T?`, left out when nil. `.nullable()` is `T?`, written
  as `null`. A request field that is both is `Patch<T>?`: nil leaves it
  out, `.clear` sends `null`, `.set(v)` sends the value (`queue.update`).
  A response field that is both is `T?`: the server writes `null` and
  nothing at all for the same absent field, and a client reads both as nil.
- `.int()` is `Int`, any other number is `Double`. Sequence numbers,
  timestamps and counts are `Int`; a few `z.number()` fields in events.ts
  (`blockIndex`, token counts) stay `Double`. No `Date` anywhere.
- `unknown` is `JSONValue?`. A record is `[String: T]`, as `Catalog["claude"]`.
- A named type the subset lists before the shapes that reuse it is emitted
  once: `BuildFacts` is the one struct behind `HelloPush.build`,
  `HelloResponse.build`; `ReviewFinding`, `ReviewNotice`
  and `GateNotice` are the notice row's payloads, named, and `PreambleStamp`
  the first user row's. An enum listed first
  (`NoticeKind`, `BatchStepKind`, `SimulatorState`, `ReviewOutcome`, …) is
  interned, so an inline literal union with the same values reads it.
- The notice row's `kind` is `NoticeKind` (`review`, `gate`, `batch`,
  `accountGone`, `unknown(String)`) and its payload fields stay optional
  (`review`, `gate`, `account`), so a `switch` on `kind` is exhaustive and
  `message` always reads, whatever the kind.
- Timestamps the server computes (`Date.now()`, seq, counts) are `Int`;
  aliax-core's account timestamps (`createdAt`, `resetsAt`, `updatedAt` on
  the snapshot) are plain numbers in its interfaces, so `Double`.

The unknown-case rule: an older app must survive a newer server. Every
`switch` over a generated enum has to handle `.unknown`; render it as
"something this version does not show" rather than failing the frame. A
frame that decodes to `.unknown` re-encodes byte for byte, so a cache can
store it and a newer build can read it.

Canonical JSON in the tests: keys sorted, no whitespace, whole numbers
without a fraction, `null` members dropped (see above). Pass
`dropNulls: false` to `canonicalJSON` where a `null` carries meaning.

## What L2 builds on top

The socket actor mirrors the renderer's connection runtime in
`src/renderer/src/lib/connection/` (thread K1):

- `Transport` — one socket to one host. `open()` resolves on the `hello`
  frame (the server sends it first; 10 s timeout), requests correlate by
  `id`, pushes stream to a listener, every close reaches `onClose` once
  with a `CloseReason` (`unauthorized` for codes 4401 and 4403, `network`,
  `server`, `protocol`, `local`, `replaced`). Here: `decodeFrame` gives
  `.push` or `.response`; `Response.output(Methods.X.self)` reads a result.
- `Supervisor` — per environment: walks the routes best first, backoff
  base 1 s, cap 5 min, jitter 0.25, reset only after a session stays up
  30 s; foreground, online and explicit retry *probe* the live session
  (`workspace.list`, 5 s timeout) and only a failed probe reconnects;
  preflights earlier routes every 2 min while on a later one.
  `TransportState`: connecting, open, reconnecting, offline, unauthorized;
  `EnvironmentStatus` adds `fresh`, `lastHello`, `lastError`,
  `nextRetryAt`, `route`, `attempts`.
- `Subscriptions` — the durable `session.subscribe` set, re-subscribed on
  a replacement session and resumed with `session.events { afterSeq }`;
  on `reset: true` throw the fold away and take the rows as a fresh tail.
- Credentials: pair once with `POST /api/pair { code, kind: 'key' }`
  (`PairKeyResponse`), keep the key in the keychain, mint a 30 s ticket at
  `POST /api/ticket` (`TicketResponse`) and open `/ws?ticket=…`.
- Reading: `session.list` is a page (`sessions`, `cursor`); walk the cursor
  and merge by id. `session.events` with `tail` for a cold open, `beforeSeq`
  plus `tail` for older pages, `afterSeq` alone to resume. Rows carry
  `OmittedBody` values where a body was large; show `head`, `lines` and
  `bytes`, and fetch `session.rowBody { sessionId, seq }` when the row
  opens. Persisted rows never change, so cache by session and seq.
- Pushes to handle: `events` (one session's rows in order), `sessions`
  (newest meta per session), `queue`, `session-removed`, `session-moved`,
  `workspaces`, `projects`, `live-edits`, `builds`; and the feature pushes:
  `notes` (a thread's notes changed), `batch` (a master's batch moved),
  `resources` (a thread's ledger rows), `boot-resume` (threads resumed
  after a restart; dedupe by `at`), `accounts` (the whole snapshot),
  `host.devices` (while a watch is open), `host-log` (after `host.log`),
  `macBridge.held` (Mac calls a paused thread holds). The singular `event`
  and `session` frames never arrive on a remote socket.
