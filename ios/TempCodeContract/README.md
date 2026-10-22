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
  encodes it again and compares canonical JSON.

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
speaks: the hello frame and the remote pushes, every row kind, the session,
project, workspace, queue and remote-access types, the HTTP bodies of
pairing, and these methods: `catalog.get`, `workspace.list`, `project.list`,
`project.changes`, `project.diff`, `session.list`, `session.events`,
`session.rowBody`, `session.subscribe`, `session.unsubscribe`,
`session.send`, `session.interrupt`, `session.approve`, `session.answer`,
`session.permission`, `session.continue`, `session.reroute`,
`review.override`, `session.notes.get`, `session.notes.set` (a
`ThreadNotesDoc`; the `notes` push carries the same), `queue.*`, `remote.*`
(the ten key, pairing, session and settings RPCs). The review and gate
payloads a `notice` row carries are named types (`ReviewNotice`,
`ReviewFinding`, `GateNotice`, `GateStep`), as are the preamble stamp and
the two answers (`RerouteAnswer`, `ReviewOverrideAnswer`). The project
plan's `projectPlan.get`, `projectPlan.pin`, `projectPlan.tick` and
`projectPlan.link` are in too (with `ProjectPlanState`,
`ProjectPlanMilestone`, `MilestoneLink` and `ProjectPlanTickAnswer` from
src/shared/contract-projectplan.ts; `linkOf` stays off the phone, nothing
there reads it).

To cover another method: add a `method('x.y', OutputSchema)` line (params
come from `src/shared/contract.ts` by name; the output schema lives in
`src/shared/wireSchemas.ts`, where every server → client shape is zod and
pinned to its TypeScript interface by a type-level check), run
`bun run gen:swift`, commit `Generated/`. A new push or named type is a
`union(...)` or `type(...)` line the same way.

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
- `unknown` is `JSONValue?`. A record is `[String: T]`.

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
  (newest meta per session), `queue`, `session-removed`, `workspaces`,
  `projects`, `live-edits`, `builds`. The singular `event` and `session`
  frames never arrive on a remote socket.
