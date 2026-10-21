# Master threads

A project's master thread starts, watches and steers a batch of root
threads. This is the long account: why the shapes are what they are, how
the pieces fit, what is on the wire, and what proves it. CLAUDE.md "Master
threads" is the short one.

## Why

The iOS build ran fifteen implementation threads at once from one chat
thread. It worked because the person talked to that chat, not because the
app knew it was special: an orchestration thread supervises only the
subagents it spawned, and the chat had no tools over the threads it had
started. Three things hurt:

- Every thread ran typecheck, vitest and the build because its preamble
  said so, and the rebase rule made it run them twice. Fifteen gates on
  one box is the load this feature exists to end.
- A thread over its parent's cap was refused and had to retry, so a
  starter that wanted fifteen rows had to babysit the count.
- Fable was approved for nobody, so a chat that wanted Fable for a child
  routed around the policy through `app_start_thread`, which did not check
  it.

The fix is a role, a queue, a policy by role and one gate per batch.

## The master is a role, not a type

One thread per project is pinned as its master (`projects.master_thread_id`,
`ProjectMeta.masterThreadId`). Any root thread of the project can be it;
in practice a chat. The pin is "Make master thread" / "Not the master" on
the thread's context menu (the rail row and the tab) and the RPC
`project.setMaster { projectId, threadId | null }` (admin). Clients hear it
as the `projects` push. The master's tab reads one muted "Master" after its
title; nothing else in the rail marks it or its children.

A master is an orchestrator under every rule that asks: `policyRoleOf
(session, master)` in src/shared/rules.ts answers `'orchestrator'` for an
orchestration thread, an orchestrator agent or a master, and `policyRole
(session)` in orchestration.ts reads the pin from the registry. Its prompt
carries `MASTER_MECHANICS` through `mechanicsFor`, and the claude driver
denies it Edit, MultiEdit, Write and NotebookEdit, as it does an
orchestrator without self-edit: the master steers, the batch edits.

Why not a new thread type? An orchestration thread is one run: its
children are subagents, its view the fleet board, archived when done. A
master lives as long as the project and its children are proper threads.
The mechanics are the same tools; only the scope differs.

## The children are root threads

A batch thread is a root thread of any type, model, effort, context window
and host that carries the master's id (`sessions.master_id`,
`SessionMeta.masterId`, `session.create { masterId }`) and, when it must
wait for a sibling, that sibling's id (`after_id`, `after`). They are not
subagents: a subagent has a `parentId`, folds under its parent in the rail
and reads its notes through the parent's digest. A batch thread has its
own rail row, its own tab, its own view and its own notes, and outlives
the master's turn. What the master gets is supervision by id:
`supervisedBy(caller, session)` is the one check every supervision tool
runs, and it admits the caller's subagents plus, for a project's master,
every root thread on this host that carries its id. The refusal reads "is
not a subagent or batch thread of this session".

The master starts a child with `app_start_thread`: when the caller is its
project's master the new thread gets `masterId` and, if named, `after`.
From the board, "+ Thread" opens the add sheet (type, model, effort from
the policy's ladder, context, host, after, brief) and does the same
through `session.create`. `list_agents` marks each row `subagent` or
`thread`; a batch row carries its type, model, effort, host and status.

A batch thread settling (idle, error or waiting, never a pause) reports to
the master through `settleTarget` and `notifyParentOfSettle` as a subagent
reports to its parent: a `<subagent-report>` that names the thread, its
status and its last words, and for a waiting thread the question with its
`requestId`, so the master answers it with `answer_agent`. A
`wait_for_agent` in flight takes the settle instead of a report. A plan
child's plan-complete report (planFlow.ts) is its one report, not two.
Two threads naming each other as master wake neither. Children on other
hosts are not supervised yet.

## The queue and the cap

A thread the host cannot run yet is created `queued` and started later,
never refused. Two reasons to queue: the host's running cap
(`threads.maxRunning` in the settings table, default 4, 0 = unlimited,
src/shared/threadCap.ts; Settings → General's "Run at most this many
threads at once"; RPCs `threads.get` / `threads.set`) and an unmet `after`.

Why queue and not refuse? A refusal makes the starter count slots and
retry; a master that wants fifteen rows should get fifteen rows, four
running and eleven waiting, each started as another settles. The Mac load
guard already does this for bridge commands.

`ThreadScheduler` (src/main/server/scheduler.ts) owns the decision. The
count is root threads in `starting`, `running` or `waiting`; subagents
never count, and neither does a paused, idle, watching, stopped, queued,
errored or done thread. `after` is met when the sibling is `done`, or
`idle` after at least one turn, or archived or deleted; a sibling that
errored, stopped or paused keeps the waiter queued and its line says so.
Only a request that opted in queues: `session.create { queue: true }`, or
any thread with a `masterId`; a person's own new thread starts at once.

The decision is `admit` on the FIRST message in `SessionRegistry.send`,
which every start path ends in: the user row and its preamble stamp land
exactly as a held-back boot stores them, the status goes `queued`, and the
message waits at the front of the thread's queue. `startQueued` (the
scheduler when a slot frees; `session.start { sessionId }` from the
strip's "Start now", past the cap and `after`) sends it through the same
path, `queued` → `starting`; after a restart the first user row is the
message. `tick` runs oldest-first on every meta change and removal, when
the cap changes, and after boot only once the BootResumer is done
(`holdUntil`). The master itself is a root thread and counts while it is
in a turn, so under a cap of two a master in a wake turn leaves one slot
for its children.

A queued root's `activity` reads "Queued · 3rd in line" or "Queued ·
waiting for <sibling>" ("(errored)", "(stopped)" or "(paused)" appended),
pushed only when it changes. The rail draws a still gray dot, the tab edge
"Queued" with that line as its tooltip, the working strip the line with
"Start now". The fleet switches' Stop and Archive done take a queued root
as "remove from the queue" and archive it (lib/threadBatch.ts); Pause and
Resume leave it. The boot resumer and the liveness sweep never touch it.

## The policy by role

The model policy's `approved` is `true`, `'orchestrators'` or `false`
(src/shared/rules.ts). `modelApproved(rules, provider, model, role)` lets
an `'orchestrators'` model through only for an `'orchestrator'` role.
Settings → Orchestration's model row reads Everyone / Orchestrators only /
Off. Fable (`claude-fable-5-1`, `claude-fable-5`) defaults to orchestrators
only in `DEFAULT_RULES.models`; a saved rules object replaces the whole
map, so a database with its own entries keeps them.

Both start paths check it with the caller's role: `spawn_agent`
(`resolveSpawnSpecs`) and `app_start_thread` (`appStartThread`, at its
`resolveModel` call; a start on another host goes through it, so the box
thread's role decides). With no model named both take the provider's
default under the policy (`approvedDefault`: the catalog default when
approved, else the first approved model, so a chat asking for "claude"
gets Opus, not a refusal) and clamp the effort with `fitReasoning`. A
refusal names the model, the role and the approved table in the same
words on both paths: "approved for orchestrators only, and this thread
(role: thread) may not start it". `spawnableModels(rules, role)` renders
the rows a caller may spawn; for a `thread` caller the orchestrators-only
rows carry "(orchestrators only)" and one line says an orchestration or
master thread may start them. A plan → build hand-off and the phone's New
thread are a person's choice and are never policy-checked.

## The gate out of the children

Every thread lands through the `merge_branch` app tool (mergeReview.ts):
the optional review, then the gate, then the fast-forward and push. The
gate step depends on who calls (`MergeReviews.stepFor`): a batch child (a
session with `masterId`) runs `bun run typecheck` alone in the branch's
worktree; a thread outside any batch runs `bun scripts/gate.ts --tier
commit --since <merge-base>` there, the commit tier its preamble used to
make it run itself. Both run on one `GateQueue` per host
(src/main/server/gateQueue.ts: FIFO, one run at a time, a waiter told its
position), so two runs never share the box's cores.

Why typecheck per land and the commit tier once? A typecheck break is
named to the thread that made it, which is the one that can fix it. The
tests and the build prove the merged tree, and the merged tree exists
once, at the batch's end. A child runs the tests it wrote or touched
itself, since a thread that cannot run its own test writes a wrong one.

A red run answers "HELD: typecheck failed on <branch> · 3 errors", the
last 20 lines, "call merge_branch again", and lands a `notice` row of kind
`gate` (`GateNotice { step, branch, ok, log, at }`, src/shared/gate.ts)
that the transcript draws as surfaces/GateCard.tsx with the tail folded
and no actions; a green run lands the same row, quiet. It sits beside the
review's `ReviewNotice` row: the review decides whether the branch may
merge, the gate whether the tree is green, and a head that passed review
is not reviewed again when its gate held it. "Merge anyway" past a held
review skips the gate: it is the person's call. The runner is gateRun.ts:
it finds bun where the app does (`BUN_INSTALL`, `~/.bun`, Homebrew, else
PATH), puts that directory ahead of the child's PATH because gate.ts and
release.ts spawn `bun` by name and the box's service has no bun on its
own PATH, and drops the post-commit hook's `GIT_*`.
`TEMP_CODE_GATE_STUB=<json>` (rules `{ step, branch?, ok, log? }`) decides
a step without spawning, for the proofs.

`Batches` (src/main/server/batch.ts) keeps three steps per master in the
settings row `batch:<masterId>`, so a restart keeps them; `pending` is
read from the sessions table on every read.

- `land` follows `merge_branch`'s landings through `onLanded`: "3 of 7
  landed", done when every unarchived child has landed, or at `batch_gate`
  with "4 of 7 landed · 3 left out".
- `gate` is the master's `batch_gate` app tool (the master only, by the
  project's pin at harness boot; codex over the bridge as `app.batchGate`,
  refused off the master): `bun scripts/gate.ts --tier commit` on the
  project checkout at the project branch's head, on the same queue, its
  `✓ step 12s` lines streamed into the step's `detail`; it answers "passed
  in 4m 12s · release-N tagged" or "FAILED at vitest" with the tail.
- `release` follows a green gate with `bun scripts/release.ts "<master
  title; landed subjects>"` ("release-N tagged"; `release: false` leaves
  it).

A red gate, or a landing after it, reopens the gate; a landing after a
release starts a new cycle. `batch.get` answers the live state and every
step change is the `batch` push (`{ push: 'batch', state }`, every client;
not in the phone's subset).

The house preamble (`HOUSE_PREAMBLE`, projectPreamble.ts) now tells a
thread to run typecheck and the tests it wrote or touched, never the full
suite or the build, and to land with `merge_branch`; a saved workspace
default still equal to the old text is rewritten once
(`migrateHousePreamble`, marker `preamble-migrated:batch-gate`), an edited
one is left alone. The post-commit hook's train is unchanged.

## The view

docs/LAYOUT.md "Master" has the diagram and the rules. The choices, from
the mock:

- **Borrowed.** The board | sash | chat recipe (SplitShell) every board
  thread uses, the chat on the right folding to an edge tab. A child row
  is the fleet's agent row (fleet/rowBits.tsx, shared with AgentRow). The
  unfolded row is the agent detail's feed, docked in place instead of a
  modal. The settle rows in the chat are the reports the master already
  receives.
- **Grouping by what the row needs from you.** Needs you, Running, Queued,
  Done. With ten children the question you ask the board is "who is
  blocked on me", so that group leads, and the title bar repeats the
  counts only as a sentence.
- **Queued as a visible state.** The row exists, dimmed, with the reason
  it waits, and the master never has to retry.
- **The batch's own work under the list.** Merge queue, Gate once,
  Release: three lines, not a panel, because they are the batch's state
  and not a child's. They stay put while the list scrolls.
- **One sheet for a child's identity.** Type, model, effort, context, host
  and an optional sibling to wait for. The same shape serves the button
  and the master's own tool call.
- **Left out on purpose.** No cost column, no provider logos, no per-row
  progress bars, no badges on the title. The type and host read as two
  muted words after the title.

Files: surfaces/threads/MasterView.tsx (routed when the session is its
project's master, whatever its type), master/useMasterModel.ts (the
grouping, the sentence, `useBatchState`: `batch.get` on mount, every 5 s
while the pane shows, and the push through `batchFromPush`),
master/MasterRow.tsx, master/BatchFoot.tsx, master/AddThreadDialog.tsx,
lib/masterThread.ts (`isMasterThread`, the renderer's read of the pin).

## The wire

- Sessions: `master_id`, `after_id`; `SessionMeta.masterId`, `.after`;
  the `queued` status in `SessionStatusSchema`. Projects:
  `master_thread_id`; `ProjectMeta.masterThreadId`.
- `session.create { masterId?, after?, queue? }` (operate),
  `session.start { sessionId }` (operate), `project.setMaster` (admin),
  `threads.get` (read) / `threads.set` (admin), `batch.get` and
  `batch.children` (read; src/shared/contract-batch.ts: `BatchStep` land |
  gate | release, `BatchState`), `app.batchGate` (local, the codex
  bridge).
- Pushes: `batch` (every client), `projects` on a pin change, the ordinary
  `session` meta with its `activity` line for a queued row.
- The Swift contract carries `queued` and `GateNotice`; the `batch` push
  is outside the phone's subset and its decoder folds it into `unknown`.
  The phone draws a queued root with the starting dot and the label
  "Queued" (StatusDot.swift); on Home it is not under Running
  (`HomeModel.isLive` counts running and starting only) and sits with its
  project's threads, where the label says what it is. No phone surface
  was added.

## Proofs and tests

- `bun run script:e2e-master-batch` (scripts/e2e-master-batch.ts) is the
  whole flow in one process: a scratch repo with a bare origin, cap 2,
  every gate step stubbed, haiku threads against the real provider. A chat
  thread pinned as master starts four children of three types with its
  own `app_start_thread` calls (one `after`); two run and two queue with
  their lines; `list_agents` marks the rows `thread`; settles wake the
  master, the waiting child is answered through `answer_agent`, the plan
  child reports once, the `after` child starts only once its sibling is
  idle after a turn, never more than two children are live; child a lands
  through `merge_branch` held then merged; a chat that is not the master
  is refused Fable by both tools while the master's `spawn_agent` is not;
  `batch_gate` answers the tag and `batch.get` shows every step done.
- `bun run script:e2e-queue`: six haiku threads under cap 2, never more
  than two live, `after` holds and releases.
- `bun run script:e2e-batch-gate`: a pinned master, two haiku children,
  one typecheck stubbed red then green, then `batch_gate`.
- Unit tests: rules.test.ts (the tri-state, the master flag),
  orchestration.test.ts (the table by role, supervision, settle reports,
  the refusal wording), apptools.test.ts (the policy at `app_start_thread`,
  `masterId` and `after`), scheduler.test.ts, threadBatch.test.ts,
  gateQueue.test.ts, gateRun.test.ts, mergeReview.test.ts, batch.test.ts,
  projectPreamble.test.ts, planFlow.test.ts; the renderer's
  useMasterModel.test.ts, MasterView.dom.test.tsx, GateCard.dom.test.tsx,
  TabIndicator.dom.test.tsx, WorkingStrip tests, ThreadHeader.test.ts and
  WorkspaceSessions.dom.test.tsx.

None of the proofs that boot harnesses are in the release gate.

## Not yet

- Batch threads on other hosts are started (`environmentId`) but not
  supervised as batch rows; `list_agents` lists them through the
  cross-host link as before.
- A non-master passing `after` to `app_start_thread` has it dropped; the
  tool description says it is for a master.
- The master counts against the cap while it is in a turn, like any root
  thread. A master with many wake turns under a low cap slows its own
  batch; raise the cap or accept it.
