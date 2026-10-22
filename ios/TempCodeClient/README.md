# TempCodeClient

The phone's half of temp-code's remote wire: a Swift 6 package that pairs
with a host, keeps one supervised WebSocket per host, mirrors what it has
seen into an on-disk cache, and hands SwiftUI an observable model. It sits
on `../TempCodeContract` (the generated wire types) and under `../TempCode`
(the SwiftUI app). Thread L2 built it; L3 (actions) and L4 (push, Live
Activity) build on the extension points at the end.

Platforms: iOS 18, macOS 15 (the tests run on the Mac). Toolchain on this
Mac: Xcode 27 beta (Swift 6.4) through `DEVELOPER_DIR`; the Command Line
Tools stay selected.

## Layout

```
Sources/TempCodeClient
  Connection/   Backoff, Status (TransportState, EnvironmentStatus, CloseReason, HaltReason),
                WebSocketConnection (+ URLSessionWebSocket), Transport, TempCodeSocket
  Environments/ PairedEnvironment + PairingLink, KeyStore (Keychain, in-memory), RemoteAPI, EnvironmentStore
  Cache/        Database (sqlite3), SessionCache
  Client/       Subscriptions, EnvironmentClient (+ MovedThread), ClientRegistry, SearchRows, CrossHostSearch
  Rendering/    ThreadFold (rows → stamped items + BoardState), Transcript (item types), Board,
                ResearchBoard, Fleet, PlanDoc, Inbox, DiffDocument (the diff screen's lines,
                hunks and column geometry), MarkdownBlocks, MarkdownCache, PlanDocument,
                PlanPages, ProjectPlan, ProjectPairs, CrossHost, PathHost (two hosts: pairs, cross-host
                children, the host of a path), TranscriptRows (entries → the list's rows:
                items, activity groups, turn ends), ToolPhrase (the desktop's toolPhrase.ts)
  Design/       TimeFormat, ModelName, CompactNumber, ThreadRowModel: the design kit's pure
                logic, tested here; the app's Design/ holds the views
  Support/      SocketClock (SystemClock, ManualClock)
Tests/TempCodeClientTests
  fake-socket and manual-clock suites, cache and client suites, LiveServerTests (a real server)
```

## The pieces

**PairedEnvironment** is one host: the environment id its `hello` reports,
a name, the origin (`https://tempcode.landonhale.com`, or
`http://127.0.0.1:7677` for a dev instance), the key's capabilities. The key
itself lives only in the **KeyStore** under the environment id: the Keychain
on the phone (`KeychainKeyStore`, after first unlock, this device only), memory
in tests and proof runs.

**RemoteAPI** is the http side: `GET /api/hello`, `POST /api/pair { code,
kind: 'key' }`, `POST /api/ticket`. Its errors say what to do next:
`unauthorized` (never retried by itself), `forbidden`, `rateLimited(retryAfter)`,
`rejected`, `unavailable`.

**EnvironmentStore** (`@MainActor @Observable`) holds the paired
environments as a JSON file in Application Support. Add by pairing link
(`<origin>/pair#XXXXX-XXXXX`) or by a key made on the desktop; pairing the
same host again replaces its key; remove deletes the key.

**Transport** is one socket to one host, the desktop's `Transport`
(src/renderer/src/lib/connection/transport.ts) as an actor. `open()` resolves
on the `hello` frame, which the server sends first, with a 10 s timeout;
requests correlate by id and come back typed (`TransportError.server` for
`ok: false`, `.isForbidden` when the key lacks the capability); pushes
stream from `pushes`; every close reaches `closed()` once with a
`CloseReason`. Close codes 4401, 4403 and 4001 (revoked), and a refused
upgrade (401/403), are `unauthorized`. The socket is a `WebSocketConnection`
behind a factory, so the unit tests script it; `URLSessionWebSocket` is the
real one, and URLSession negotiates `permessage-deflate` with the server
(the live suite checks the negotiated extension).

**TempCodeSocket** is the supervisor, one per environment, the desktop's
`Supervisor` as an actor: mint a ticket, open, check the hello, keep the
session, retry, probe. The policy is the desktop's, plus one state for the
phone:

| State | Meaning | Leaves it |
|---|---|---|
| `connecting` | no session yet since start or retry | hello → `open`; failure → retry timer (stays `connecting`) |
| `open` | a session is up | loss → `reconnecting`; unauthorized close → `unauthorized`; background grace → `suspended`; foreground after sleeping through the grace → closed and replaced at once (`reconnecting`, no delay) |
| `reconnecting` | a session was lost; `nextRetryAt` says when | timer → attempt; `retry()`/foreground/online → attempt now |
| `offline` | the OS says no network, or the socket **halted** (`halt`: identity changed, contract mismatch) | online → probe/attempt; `retry()` lifts a halt |
| `unauthorized` | the key was refused (ticket 401/403, close 4401/4403/4001) | only `retry()` |
| `suspended` | in the background, closed after the grace | foreground → attempt now |

Backoff: 1 s doubling to 5 min, ±25 % jitter, the attempt count resets only
after a session has stayed up 30 s; a rate-limited mint waits at least its
`Retry-After`. Probes: foreground, online and `retry()` send `workspace.list`
over the live session with a 5 s limit; a good probe marks `fresh`, a failed
one closes the session and reconnects at once. Background: `setForeground(false)`
starts a 10 s grace, then closes the socket and waits; coming forward before
the grace ends only probes. iOS freezes the process seconds after it leaves
the screen, so the grace timer usually never runs: coming forward with the
socket still held and more than the grace elapsed on the clock means the
socket is stale, and it is replaced at once rather than probed for five
seconds (`ManualClock.skip(ms:)` plays the frozen process in tests). A hello whose `environmentId` is not the paired
one, or whose `contract` is not `contractVersion`, halts with a `HaltReason`
the status line can explain ("update the app" vs "update the host").

**Subscriptions** is the durable `session.subscribe` set (the desktop's
`Subscriptions`). On every replacement session it forgets what was subscribed
and `resumeAll` re-subscribes each open thread and resumes it with
`session.events { afterSeq }` from the owner's cursor, four at a time. The
reset rule: a page with `reset: true` means the gap outgrew the host's replay
budget and the rows are a fresh tail, so the owner drops its fold first.
Pushes received during subscribe and gap fetch wait behind the captured
cursor, then merge in seq order without duplicates.

**SessionCache** is the on-disk mirror: SQLite through the system `SQLite3`
module, one file at `Application Support/TempCodeClient/cache.sqlite`, WAL.
Tables, all keyed by environment: `workspaces`, `projects`, `sessions`
(`updated_at` for the newest-first list), `rows` (`session_id, seq, ts, json`,
primary key on session and seq so a replayed row can never duplicate),
`bodies` (whole rows from `session.rowBody`, kept for good because persisted
rows never change), `session_state` (`more_before`). Values are the wire's
JSON, which the contract re-encodes byte for byte, so an older build can hold
what a newer host sent. A thread keeps its newest 1,000 rows (pruned past
1,300); the app paints the newest 300 and pages older ones 200 at a time,
from the cache while it has them, then from the host with `beforeSeq`.
Board threads paint that tail first, then page to the first row and build
the full fold off the main actor. They retain that history in memory while
open so later pushes preserve old todos, rounds and sources. A loading or
error line marks an incomplete board. Search navigation pages back up to
100 times and resolves the exact row to its folded item; a missing row
shows a status message.

Why raw sqlite3 and not GRDB: the schema is six tables of JSON blobs behind
primary keys, the wrapper (`Database.swift`) is shorter than GRDB's record
protocols would be, and the release gate builds this package on every
commit: no dependency to resolve, nothing to fetch.

**EnvironmentClient** (`@MainActor @Observable`) is one environment as the
app sees it: `status`, `workspaces`, `projects`, `sessions` (newest first),
`threads[id]` (`ThreadState`: rows oldest first and unique by seq,
`moreBefore`, `isLoading`, `isLoadingOlder`, `isLive`, `goneReason`).
`start()` paints from the cache, then connects; on each new session the open
threads resume first (`visibleThread`, the one on screen, at the head of the
first batch) while the shell catches up alongside in one round trip
(workspaces, projects, and `session.changes` from the cursor the cache
kept), and `fresh` is marked once both are done. `visibleThread` and
`listVisible` say what the person is looking at; a change anywhere else is
published through `quietly` (the app sets a transaction with animations
off), and a list that comes back as it was is not republished at all, so a
catch-up moves nothing that was already true; a page with `reset` is a
fresh paint and lands quietly even on screen. `isLoading` is true only while
nothing has painted.

The session list reconciles the way the desktop's launch mirror does.
`listCursor` is the head of the host's change log (`ListCursor`: `seq` and
`generation`, in the cache's `cursors` table, loaded at `start()`); the new
session asks `session.changes { afterSeq, generation }` and gets the metas
that changed and the ids that left since, merged in place (archived metas
ride the log too, so there is no archived walk), and the new head is saved.
On `reset` (another run of the server, or a cursor older than the 5,000
entries the log keeps), with no cursor (`afterSeq: 0` goes out beside the
first `session.list` page, no extra round trip) or when the host refuses
the method (an older build; the cursor is dropped), the whole `session.list`
walk runs as before, with the archived walk off the open handler, and the
head taken BEFORE the walk is the cursor, so changes that land during the
walk are replayed next time rather than lost; a walk cut short drops the
cursor, so the next session lists whole again. `shellSource` says where the
list came from last (`none`, `cache`, `changes`, `list`). `bootResume` is
the host's restart notice (`BootResumeNotice`: count and the boot's time),
set once per boot from the `boot-resume` push the host repeats on every
socket, deduped through the cache's `notices` table; `dismissBootResume()`
clears it. The thread on screen is re-marked seen when its meta lands after
its rows (`merge`) and when its first page lands (`fold`), so the catch-up
never leaves it unseen. `peekTail` (Home's needs-you cue) answers a live
thread's rows, else the cached tail only while the thread's meta has not
moved since the tail was fetched (`peeked`), else one page from the host
into the cache, and the cache alone with no socket. Pushes:
`events` append to an open thread (ephemeral rows stay out of the cache),
`sessions` merge newest-first, `session-removed` drops the thread,
`session-moved` drops it too and keeps a `MovedThread` (the destination's
environment id, the subagents, when) in `moved` under the root's and each
subagent's id for this process, so a screen open on the thread can say where
it went; `projects`/`workspaces` replace. `openThread` paints the cached tail at once
and resumes without blocking the caller; `closeThread` leaves the set so a
reconnect never replays what nobody looks at; `body(sessionId:seq:)` answers
an omitted body from the cache or one `session.rowBody`; `assetRequest(host:
path:)` is a `GET` for `/asset/<host>/<path>` with the key as the bearer
(logos, media, agent pages; the server accepts an app key there since L2).

**ClientRegistry** holds one client per stored environment, starts new ones,
tears down removed ones (socket stopped, cache cleared), and fans
foreground/online out to every socket.

**ThreadFold** turns rows into what the screen shows and what the board
counts, one row at a time (`apply`) or whole (`fold`), by the desktop's
rules (fold.ts, todos.ts): assistant text and thinking merge by `(msgId,
blockIndex)` with deltas appended until the final row replaces them (the
final row's time is the block's `doneTs`); a tool call and its result pair
by `callId` (an omitted output keeps the seq that fetches it; the result's
time is `doneTs`); questions and approvals resolve in place by `requestId`;
a compaction's `done` updates its `start`; `turn-complete` (or an idle,
error or watching status) closes the open user turns; `errors-cleared`
drops the error lines; an unknown row kind becomes a quiet "this version
does not show" line. Every item is a `ThreadEntry` stamped with the
`round` it answers, the `todo` in progress when it was born (-1 before any
list) and whether it landed in a completed-turn `pass`. `Transcript.fold`
is the items alone.

**BoardState** is the desktop's todo model: `todos`, `activeTodo`, the
`round` and the archived `rounds` with their `costs`, `usage` marks, `cost`,
`stopped`, `compacting`, the `sources` (research-source rows kept whole) and
the spawned `agents`. A user message on a closed turn opens a new round
(`beginTurn`: explicit `newPass` wins; else "unfinished and warm within 30
min means resume"; a turn silent 10 min is dead); TodoWrite and update_plan
replace the list, TaskCreate and TaskUpdate build it up by the "#3" the
create's result reported; a plan-tool call moves the model before its own
row lands, so it and everything after belong to the new todo.

`EnvironmentClient` keeps `threads[id].fold` current: rows that extend the
tail apply incrementally, anything else (a replacement, an older page, a
reset, a trim) folds again. A partial tool call (ephemeral, seq -1) is one
row per call replaced in place and retired by its final row; `cursor` skips
it.

The selectors the screens read: **Board** (rounds.ts: `groupByTodo`,
`activeMs`, `actKind`, `editPath`, `changeStat`, `wholeChange` →
`ChangeCard`, `diffLines`) and **ImplementationBoard.build** (one
`RoundData` per request with its todos, items, work and header; passes
numbered by what the board shows and coloured from the desktop's wheel; the
closing report once every todo completed, or the answer when a follow-up
made none); **ResearchBoard** (researchBoard.ts: angles with their queries
and sources, unique totals, `mergeAngles` with the spawned children,
`host(of:)`); **Fleet** (agents.ts: rank and sort, `children(of:in:)`,
`counts`, the activity and status `line`, `stats`, `loadsTranscript`);
**PlanDoc** (planDoc.ts: sections, the task checklist, progress, the H1,
report frontmatter); **Inbox** (the desktop's InboxView.tsx and github.ts:
`InboxModel` sorts every host's items newest first, picks the one status
word and its tone, keeps the seen marks and their first-snapshot seed and
writes the notices; `InboxPatch` splits a unified patch by file for the
diff screen and lines the blocks up with the host's file metadata).
**MarkdownCache** (`@MainActor @Observable`) parses a
row's markdown into `RenderedBlock`s with inline `AttributedString`s off
the main actor (`@concurrent`), keyed by environment, session, seq and text hash: a read is
synchronous, a miss parses and lands as an observable change, a changed
row shows plain text until its own parse lands. **PlanDocument** is the
plan page's parser: the file's frontmatter lifted out, then blocks with
nested and task lists (depth, ordinals, checkboxes), pipe tables with
alignments, fences, quotes and rules, inline markdown resolved; `sections(
level:)` cuts it at its headings for a composed page. **PlanPages**
(`@MainActor @Observable`) is the pages' store: the last text of every
plan on disk under `Caches/plans/` so the next open paints before the
socket answers, the document per page kept through a re-parse (a short
text parses on the first paint, a longer one off the actor, a newer text
superseding a parse in flight), and the reading position per page in
`UserDefaults`; both the directory and the defaults are injectable. **ProjectPlan** (projectPlan.ts, line for line:
the frontmatter status, the title, the sections in order and the missing
fixed ones, the milestones under `## Milestones` with index, title, done,
scope, dependencies, done-when, body and line, fences skipped; progress,
next, the summary and chip text, dependency chips, the two milestone
briefs, the thread title, the revise text and the optimistic-tick
reconcile) and `ThreadDraft.milestone(from:milestone:kind:…)`, the planning
or orchestration draft for one milestone; the phone never writes the file.

**SearchRows** (`Client/SearchRows.swift`) is the Search tab's pure side:
the flat row model (`SearchRow`: thread head, hit, project head, file,
project, more), `SearchRows.build` shaping every host's raw `session.search`
and `search.project` answer into it in rail order (note hits with `seq`
nil, 40 file rows per project, the per-host foot), `MatchRanges` (the
query's words longest first, case and diacritic insensitive, as character
offsets the views set in weight), `SearchDebounce` and `footLine`.
`build`'s body is the slot the cross-host selector (merge, rank, fold,
typed filters) replaces; the screen calls it from one line.

**CrossHostSearch** (`Client/CrossHostSearch.swift`) is that selector: the
fan-out over every open host as an `AsyncStream<SearchAnswer>` (a batch per
landed source, the three calls injected as `SearchAsk` closures), the
host-neutral scoring and total ordering, the paired-file fold through a
`PairLookup`, `ParsedQuery` (`host:`, `type:`, `project:`), and the per-host
feet with the offline skip; `SearchRows` stays the row model it emits.

**ProjectPairs** (src/renderer/src/lib/projectPairs.ts, host-aware: the
phone's `WorkspaceMeta` has no environment id, the client is the host): two
hosts' workspaces pair when they name the same GitHub repository, else when
their folders share a name; one member per host; `pairs(_:)` over
`HostWorkspaces` in registry order, `pair(of:on:in:)` (the deepest member
folder wins), `relative`, `partners`, and Home's `homeKey` / `homePairing`
(the pair id for a host's first workspace with that key, `<env>:<id>` for a
second same-named folder so it never folds); `showsHost(hostCount:)` is the
one rule for naming a host on a row. No path map: the default map gives both
sides one basename, and the map is an admin setting a client key cannot read.

**CrossHost** (src/shared/contract-crosshost.ts): `encode`/`decode` of a
`<env>:<session>` agent id (a local id has no colon; a malformed one stays a
local id), `Placement` (host, session, remote, paired) from a spawn row's
`childSessionId` + `environmentId` or from an encoded id, `hosts(in:)` over a
parent's rows, `hostWord` for a remote paired child, and `unpairedNote`, the
one line for a child on a host this phone has not paired (the wire carries
the id only, so it never names the host).

**PathHost** (src/renderer/src/lib/pathHost.ts): `host(forPath:owners:
threadHost:primary:)` is the desktop's rule unchanged; `owners(of:catalogs:)`
are the hosts whose project cwds or workspace paths hold the path;
`host(ofPath:threadHost:catalogs:)` makes the thread's host the primary (the
phone has no disk); `environment(ofMediaURL:)` reads `&host=` off an
`fs.media` URL; `failureText` words an ENOENT or a nil read as "No such file
on <host>."; `uploadHost(threadHost:)` is the one rule for a photo the phone
sends: always the thread's host.

**Notes** (iOS 18) is a thread's working notes on the phone.
`Rendering/Notes.swift` is the port of src/shared/notes.ts: parse, the fixed
order, replace and append, the State line, compact, demote, the brief, the
display model, `unread(updatedAt:readAt:)` for the glyph's dot and
`needsYouLine` for Home. `Client/NotesState.swift` holds one `NotesState` per
thread on the client (`loadNotes`: memory, else one `session.notes.get`;
`saveNotes`: `session.notes.set` behind the operate gate; the `notes` push
replaces the doc in place; a removed thread drops it). `Client/NotesEditor.swift`
is the edit session: the draft, the quiet period (800 ms in the app), save on
finish and on flush, a failed save that keeps the draft dirty, a remote change
measured against the text the edit began from, Load theirs.

## Tests

```sh
bun run ios:test            # ../TempCodeContract: swift build + swift test (about 10 s warm)
bun run ios:test:client     # this package, every suite: boots scripts/ios-client-test-server.ts
                            # (a real server on a temp database with seeded threads, a read key,
                            # control hooks for drop / append / clock / revoke), runs `swift test`
                            # with the address and key in the test process environment only (about 4 s warm)
bun scripts/ios-sim-proof-local.ts     # the simulator proof against that local server
TC_TEST_PAIR_LINK=… TC_TEST_PAIR_NAME=… scripts/ios-sim-proof.sh   # the proof against a real host
```

The server also boots a second host (`TC_IOS_SECOND_HOST=1`, a child
process of the same script on its own temp root: the same `ios-workspace`
folder name, an implementation thread, and the cross-host child `ios-xhost-
child` whose parent `ios-xhost` lives on the primary), exported to the test
process as `TC_TEST_SECOND_BASE_URL`, `TC_TEST_SECOND_ENVIRONMENT_ID`,
`TC_TEST_SECOND_KEY` and `TC_TEST_THREAD_CROSS_HOST`; the two-host live test
(one pair with two members, the child placed on the second host, the ghost
child unpaired, `fs.media` stamped with its host) runs only with them.

Both `ios:test` and `ios:test:client` run in the release gate
(scripts/release.ts). Without the live environment the `LiveServerTests`
suite is skipped and `swift test` in this directory still runs the unit
tests: NotesTests, NotesClientTests and NotesEditorTests (the notes port,
the client's notes state on the fake socket, the edit session with a 20 ms
quiet period), backoff bounds, the manual clock, pairing links, the store on a fake
host, the transport on a scripted socket (hello first, timeout, correlation,
pushes, close mapping), the supervisor on a manual clock (identity and
contract halts, backoff and reset after 30 s up, the 5 min cap, unauthorized
stops, rate limit, probes, background grace, offline/online, stop,
replacement sessions), the cache (cold paint from disk, duplicates, reset,
pruning, removal), the client (cold paint, shell listing, tail, pushes, drop
and resume without duplicates, reset, older pages, bodies), the fold and the
markdown splitter, the fold's stamps and board (todos per round, TaskCreate ids, warm resume versus an explicit new pass, the pass flag, sources and agents), the board selectors and the implementation board, the research board, the fleet lines and stats, the plan document readers, the inbox rules (the sort across hosts, every status branch, review verdicts, the seen marks and seed, the notices, the patch split on renames, binaries, quoted paths, CRLF and cut-short blocks, the metadata join) and the markdown cache. The action tests add the gate by key and socket, the draft payloads, and on the fake socket: a pending turn retired by its echo, a refused send, a send while the link is down, a read key refused before the wire, an approval's optimistic decision and its revert, an answer, a create that adopts and briefs, the row RPCs, and the catalog fetched once. The live suite adds: hello over http, a socket on a fresh
ticket with the negotiated deflate extension and a forbidden call, identity
and contract halts against the real hello, an expired and a reused ticket,
a dropped link resumed from the last seq with no duplicate and no gap, and
a revoked key. Nested in it, the action suite runs against the stubs with the acting key: a send echoed and stopped, an approval resolved (and refused on an operate-only key), an answer, a build from the plan, a chat with rename, pin and archive, a full-access draft refused without `approve`, and the catalog.

`TC_PROOF_SET=f4 bun scripts/ios-sim-proof-local.ts` checks an old search
hit, a missing hit and complete implementation/research boards, then gates
scrolling on zero frames more than 8 ms late. It loads all 2,002 source rows
before recording and positions the full transcript at the bottom. A display
link drives the native list offset through two 25-second glides and records
every interval, including pauses. Search hits use SwiftUI's scroll-to-row
path separately. The report includes row counts and
the simulator's actual maximum refresh rate. A 60 Hz simulator cannot
prove 120 Hz device performance.

The simulator proof uses `simctl` (build, install, launch with the pairing
link and a debug route in the app's environment, `simctl io screenshot`),
not XCUITest: with the Command Line Tools selected as the developer
directory, xcodebuild's test runner cannot reach the simulator's service
hub ("failed to bless service hub", "the test runner hung before
establishing connection") on either installed runtime. `UITests/ProofTests.swift`
is the XCUITest version for a Mac with an Xcode selected. The simulator
build is signed ad hoc on purpose: an unsigned simulator app has no
application identifier and the Keychain refuses its items, which the app
would have shown as "Key refused".

## Actions (L5): send, stop, approve, answer, create, rename, archive, pin

`Client/Actions.swift` is the phone's steering layer on `EnvironmentClient`:

- **The gate.** `Actions.block(status:environment:needs:)` answers an
  `ActionBlock` or nil before anything touches the wire: the key's standing
  first (`readOnly` when it lacks `operate`, `noApprove` when it lacks
  `approve`; these never change by themselves), then the socket
  (`connecting`, `reconnecting(retryAt:)`, `offline(reason:)`,
  `halted(HaltReason)`, `unauthorized`, `suspended`). `operateBlock` and
  `approveBlock` are the two the screens read; `ActionBlock.text(now:)` is
  the one line the composer field or a card carries, with the retry
  countdown. A host refusal comes back as `ActionError.refused(message:
  forbidden:)`, a `forbidden:` answer rewritten into what the key lacks.
- **Send.** `send(_:text:model:attachments:newPass:)` appends a
  `PendingTurn` to `ThreadState.pending` and sets `sending`;
  `ThreadState.entries` is the fold's items with the pending turns at the
  end (negative seqs), which is what the transcript shows. The host's
  `user-text` echo with the same text retires the pending turn (`settle`),
  and a `sessions` push with `starting`/`running` clears `sending`; a
  refusal drops the turn and throws. `model` is a `TurnModel`, the
  composer's chips as `session.send`'s `provider`, `model` and `reasoning`;
  `TurnModel.override(for:provider:model:reasoning:)` answers nil when the
  chips match the thread, so such a turn carries no settings. `attachments`
  are files already on the host, named by the turn.
- **Upload.** `upload(_:name:mime:data:progress:)` (`Client/Attachments.swift`)
  streams bytes to the thread's host: `attachment.begin` with the size and
  SHA-256, one `attachment.chunk` per range awaited in order (the host's
  `chunkBytes`, capped at 2 MiB), then `attachment.commit`, whose answer is
  the `Attachment` the next `send` names; `progress` is told the bytes sent
  after every chunk. A refusal after `begin`, or a cancelled task, sends
  `attachment.abort` and throws. The chunking and the digest are
  `AttachmentUpload`, pure.
- **Stop, Continue, Resume, Start now.** `stop(_:)` is `session.interrupt`;
  `resume(_:)` is `session.resume` (the host continues a paused thread or
  brings back one whose harness is gone); `start(_:)` is `session.start`,
  a queued batch thread run ahead of the sibling it waits for.
- **The strip and the button.** `WorkingPhase(status:sending:)`
  (`Client/Steering.swift`) is the working strip's state: paused, stopped
  and queued from the status; running is working; starting is sending while
  this device's send is out; everything else is idle, or sending.
  `WorkingPhase.batchPaused(of:in:)` counts a paused master's paused batch
  roots. `ComposerRules` holds the button's rules: `running` (the host's
  running or starting, or a send out; `watching` is not running), `stops`
  (only with no text), `placeholder` (Steer for a steerable root or a
  master).
- **Approve and answer.** `approve(_:requestId:allow:)` and
  `answer(_:requestId:answers:)` write `ThreadState.decisions` /
  `ThreadState.answers` first (the card reads them over the fold), send,
  and revert the overlay when the host refuses; the `approval-resolved` /
  `question-resolved` row retires the overlay.
- **Create.** `createThread(_ draft: ThreadDraft)` runs `session.create`,
  adopts the meta into `sessions` so the screen can open before the push,
  and sends the draft's `brief` when it has one. `ThreadDraft.build(from:
  plan …)` is the desktop's PlanView Start (the plan's project, cwd and
  file, the default goal by the checklist, the implement/orchestrate brief,
  `agentType` by thread type); `ThreadDraft.thread(…)` is a fresh thread in
  a project, or a chat hung off the workspace, with an optional `title`
  and `brief` for a sheet opened prefilled (the Inbox's issue). `needs` is `approve` for a
  full-access draft, as the host's gate has it.
- **Rows.** `rename`, `setArchived`, `setPinned` go out as their RPCs; the
  `sessions` push brings the row's new state. `loadCatalog()` keeps the
  host's `catalog.get` on the client for the sheets.
- **The host's rows** (`Client/NoticeActions.swift`). `continueThread(_:)`
  is the failure card's Retry (`session.continue`); `reroute(_:)` is Route
  automatically (`session.reroute`, answering `RerouteAnswer`: the account
  the thread is on now and whether that is a move); `mergeAnyway(_:runId:)`
  merges past a held review (`review.override`, an approve-key action). The
  words and the action table live in `Rendering/Notices.swift` (`GateText`,
  `ReviewText`, `FailureActions`: at most three actions, Retry last, a note
  naming what only the desktop can do).

The test server (scripts/ios-client-test-server.ts) stands in for the
registry's action methods: each is recorded (`GET /actions`, `POST
/actions/clear`) and plays out the rows a real run pushes; `POST /finish`
ends a simulated turn and `POST /ask` raises a fresh approval or question.
It mints three keys: read-only, read+operate+approve, and operate-only
(the approval card's forbidden path), and two pairings for the simulator
proof's `actions` set.

## Fleet switches, statuses, resources (thread iOS 20)

- `Client/ThreadBatch.swift` is the desktop's `threadBatch.ts` as values:
  `BatchAction`, `BatchScope` (a host or a project; the phone has no
  "everywhere"), `BatchSelection` (the seen marks and the floor the Archive
  done rule reads), `ThreadBatch` (`hasRunningTurn`, `qualifies`, `inScope`,
  `targets`, `counts`, the labels and symbols, `confirm` and `toast` with the
  desktop's strings), and `EnvironmentClient.batch(_:selection:cleanup:)`:
  one `session.batch` over what qualifies now, the answer's `failed` folded
  into a `BatchToast` naming each thread's title, a whole-call refusal
  naming every target, a read key refused before the wire.
  `batchSelection(_:now:)` builds the selection from `seen` and the pairing.
- `Client/StatusWords.swift`: `queuedLine` (the host's "Queued · waiting for
  X" through `activity`, else "Queued"), `stopped`, `batchPaused` and
  `batchPausedClause` (", and 2 batch threads with it" for a paused
  master) and `bootResume` ("7 threads resumed after restart"; the
  client's `bootResume` notice is already once per boot).
- `Client/Resources.swift`: `ResourceLedger` (`bySession` from the
  `resources` push and `resources.list`, `loadAll` over `resources.listAll`
  at every socket open, `live(for:)`, `countHeld(by:)`, `removing` marked
  from `removeResources` until the push answers), the client's
  `removeResources(_:ids:)` and `archive(_:removeResources:)` (Start now
  and Resume are the existing `start` and `resume`), and `ResourceWords`
  (kind labels and symbols, `removalClause`, `rowState`, `isWaiting`,
  `hostName`). `EnvironmentClient.resources` is the new observable.
- Tests: `ThreadBatchTests` (mirrors threadBatch.test.ts), `StatusWordsTests`,
  `ResourcesTests`, the batch, start, archive and resources cases in
  `ActionsTests`, and one live case in `LiveActionTests` (Pause all over the
  test server's running roots, Start now on `ios-queued`).

## Push (L6): the token to every host, taps to the card, the Live Activity

- `Push/PushRegistrar.swift` holds the APNs token (`Device`: token, bundle
  id, `sandbox` or `production` as the provisioning profile says), the
  Notifications switch (`push.enabled` in UserDefaults, off until the person
  turns it on) and what each host holds (`push.held`). `EnvironmentClient`
  calls `sync` at every socket open: a host without this token gets
  `remote.push.register`, a host with it gets `remote.push.status`, and with
  the switch off `remote.push.unregister`; `setDevice` re-syncs every open
  host when the token changes and `forget` drops a removed host. The host
  keeps one row per key and forwards it to the hub as an `apns`
  subscription; nothing here speaks to Apple or the hub. `summary` is the
  row's one word: Off, Not allowed, Registering…, On, No relay, Failed.
- `PushTarget` is where a tap lands: the `tc` object of a hub notification
  (`environmentId`, `threadId`, `seq`) or the Live Activity's
  `tempcode://thread/<environment>/<session>?seq=<n>`. The app's
  `NavigationRouter` turns it into `Route.thread(environmentId:sessionId:seq:)`,
  the same route a search hit takes, so the transcript lands on the row.
- `EnvironmentClient.sessionObserver` (set for every client through
  `ClientRegistry.setSessionObserver`) hears each session meta a host
  sends; the app's `ActivityCoordinator` follows a thread's status through
  it and ends the Live Activity when the thread settles. The activity's
  push token goes to the host over `remote.push.activity` (`setActivityToken`;
  `nil` ends it), and the host relays `liveactivity` pushes through the hub
  while the phone is away (the socket closes after
  `SocketConfiguration.backgroundGraceMs`). The app's
  `TempCodeNotificationService` extension reads the paired hosts' names from
  the App Group's `HostDirectory` (published by the app from
  `store.environments`) and adds the host to an alert's subtitle only when
  two or more hosts are paired. The activity's content state
  (`ThreadActivityContent`, ios/TempCode/Activity/Shared/ThreadActivityText.swift)
  is compiled into this package's test target through a symlink under
  `Tests/TempCodeClientTests/Shared/`, so `ThreadActivityStateTests` proves
  its words and numbers without ActivityKit.
- Tests: `PushRegistrarTests` (the payload and URL parsing, the row's word,
  a register at open, a status read for the same token, a second register
  for a rotated one, the unregister on the switch, the activity token).
