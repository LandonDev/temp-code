# Master threads: a project's batch of root threads

docs/master-threads.md is the long account (why, the wire, the proofs);
this is the short one.
- **The master is a role, pinned on the thread.** Any root thread is
  pinned as a master on its own row (`sessions.is_master`,
  `SessionMeta.isMaster`; "Make master thread" / "Remove as master" on the
  thread's context menu, rail row and tab; RPC `session.setMaster
  { sessionId, master }`, operate (any key that starts and steers threads;
  never admin), a subagent refused, answered as the
  thread's meta push; the row is disabled on an unsent draft with "Send a
  message first" as its tooltip, since the host pins only a thread it knows).
  A new chat is born pinned instead: an unsent chat draft's composer
  offers "Master thread" in its draft row (chrome/MasterCheck.tsx, the
  box from the select chunk, kept on the draft's record as `master`), and
  its first send passes `session.create { master: true }` (operate, like
  any create; only `permission: 'auto'` raises it to approve through
  `requiredCapability`; a subagent refused), which sets the flag before
  the eager boot, so the first spawn is a master's; the phone's draft row
  offers the same pick to any key that can send. Several threads of one project may be, each with
  its own batch keyed by its id. `projects.master_thread_id` is read once
  into the flag when the column is added and ignored since (the column
  stays; `ProjectMeta.masterThreadId` left the wire). Its tab reads one
  muted "Master" after the title; nothing else marks it.
  `isMasterSession(session)` (orchestration.ts) reads the flag off the live
  row when the registry knows the id (the harness boots eagerly at create,
  so a thread pinned after that still gets the batch tools and supervises
  its batch; its prompt and tool set were built at that spawn, so
  `setMaster` drops the handle of a booted thread with no turn running,
  pinned or unpinned (a watching master unpinned idles first), whose next
  send spawns a harness that knows what it is, and whispers
  `masterPinNotice` into one mid-turn or still booting, the next spawn
  carrying the change), `registry.isMaster(id)` in the registry,
  `isMasterThread` (lib/masterThread.ts) in the renderer. The master's
  prompt carries `MASTER_MECHANICS` through `mechanicsFor`, and the claude
  driver denies it Edit, MultiEdit, Write and NotebookEdit: it steers, the
  batch edits.
- **Subagents have titles.** `spawn_agent` (and each batch entry, and the
  codex bridge's `app.spawnAgent`) takes `title`, 3 to 6 plain words the
  transcript, the rail and the Agents list name the agent by; the
  orchestrator's prompt asks for it, `cleanAgentTitle` keeps it one line of
  at most 60 characters, and a batch entry never inherits a top-level one.
  An agent spawned without one starts on its task's first line and the host
  writes its title from the task at once (`SessionRegistry.titleFromTask`,
  the root threads' one-shot `generateTitle`; a rename before it lands
  wins, no answer keeps the first line); a spawn on another host sends
  `autoTitle` on `thread.spawn` and that host writes it.
- **The children are root threads, not subagents.** Each carries the
  master's id (`sessions.master_id`, `SessionMeta.masterId`,
  `session.create { masterId }`) and, when it waits for a sibling, that
  sibling's id (`after_id`, `after`); any type, model, effort, context
  window or host. **The batch follows the starter** (`batchMembershipOf`,
  orchestration.ts): a thread a master starts carries the master's id; a
  thread a batch root starts (a plan calling `app_start_thread` for its own
  build) inherits that root's `masterId`; `startedBy` stays the caller
  either way. It runs in `app_start_thread`, the cross-host `thread.start`
  (`masterId` rides in the args; the Mac stamps it and the box caller as
  `startedBy`) and `SessionRegistry.create` when `startedBy` names a thread
  and no `masterId` was given; the board's add sheet passes `masterId`
  itself. A plan child's auto-started build (planFlow.ts) inherits the
  plan's `masterId`, `after` and `startedBy` the same way; `planThreadId`
  links the two. `batch.adopt { masterId, sessionIds }` (operate) and the
  master's `adopt_thread { threadId }` tool (codex `app.adoptThread`) bring
  an existing unarchived root of this host in (`masterId`, and `startedBy`
  when it had none); a master, a subagent or a thread of another batch is
  refused with its reason. `batch.archive { masterId, which: 'done' |
  'all', removeResources? }` (operate) archives the children through the
  fleet's `session.batch` (done = done, or idle after a turn; all = every
  one, the queued ones archived first so stopping a sibling never starts
  them, then the live ones stopped) and leaves the master.
  `supervisedBy(caller, session)` is the one check every supervision tool
  runs: the caller's subagents, and for a master every root thread on this
  host carrying its id, and every far one of its batch whoever started it
  (crossHostAgents `childOf` reads the batch index); a refusal says why and
  what to do (`refusedAgent`: the `<host>:<id>` of a far thread, a batch
  thread's subagent is that thread's, another batch, adopt_thread).
  `list_agents` marks rows `subagent` or `thread`. Stop, archive, delete
  (docs/master-threads.md "Stopping, archiving and deleting a batch
  thread"): a person may do all three to any batch thread; a master stops
  (`interrupt_agent`: a batch thread with its own subagents,
  `registry.stopSubtree`; a queued thread leaves the queue unstarted,
  archived, which is what a Stop does to any queued row now, the master's,
  a far host's `thread.interrupt` or a tree stop) and archives
  (`archive_threads { which | threadIds }`, codex `app.archiveThreads`,
  `Batches.archiveTool`) and never deletes (irreversible: the person's;
  MASTER_MECHANICS says so). A tree stop's subagents report to no one
  (`quietSettles`), and a stopped turn's settle leaves parked reports for
  the next turn. `session.interrupt { subtree: true }` is a menu's Stop:
  the thread and what it started, never its parent (a subagent line, the
  Agents section's Stop). The renderer says every failed thread action
  with the host's reason (lib/threadActionFailure.ts), never swallows a
  Delete or Archive, and the board drops a deleted child at once
  (`useBoardLayout` remembers a listed child the store stopped holding,
  `boardLayout`'s `removed`; the host re-pushes the batch on a removal it
  listed). Proof: sessions-batch-actions.test.ts,
  MasterView.dom's board actions and `bun run
  script:e2e-batch-child-actions` (real haiku threads). A thread
  settling (idle, error, waiting; never a pause) reports to everyone in
  `settleTargets`, once each: its parent or else its master
  (`settleTarget`), and the thread that started it (`startedBy`) when that
  is someone else, so a plan's build started by the plan reports to the
  master and to the plan; `notifyParentOfSettle` writes the
  `<subagent-report>`, a waiting one with its question for `answer_agent`;
  a `wait_for_agent` in flight takes the settle instead; a plan child's
  plan-complete report is its one report; two threads naming each other as
  master wake neither. A thread a master (or a batch root) starts on
  another host is a batch member there and counted here: the asking side
  indexes it under the master (`crossHost.batch.<masterId>`),
  `Batches.members` joins it with the local roots keyed
  `<envId>:<sessionId>`, `batch.get` lists every child with its host
  (`children`), its state comes from the settle pushes and one
  `thread.list` per host when the local children are done (a far child is
  done when its host says `done` or `idle`), a host out of reach blocks the
  end as `unreachable` naming the host, Pause and Resume cascade to it
  (`thread.pause/resume`), `batch.archive` archives it there
  (`thread.archive`, listed in `succeeded`), `batch.adopt` takes a
  `<envId>:<sessionId>` root (`thread.adopt`), and it lands through its own
  host's `merge_branch`, which asks the owner first (`crossHost.landing`:
  held with `{ branch, host }` under all-at-once after a push to origin,
  else merged and pushed there and reported); the owner's land step fetches
  origin and fast-forwards the project checkout before the gate and release,
  and merges a held far branch from origin. docs/box.md "A master's batch
  across hosts".
- **A thread is the person's choice; the model policy is for subagents.**
  The orchestration rules (src/shared/rules.ts `modelApproved`,
  `approvedDefault`, `fitReasoning`; Settings → Orchestration's Everyone /
  Orchestrators only / Off, Fable orchestrators-only by default, and a
  model the saved rules do not list is Off: a copy saved before that rule
  is written out once with every catalog model it lacked as Everyone,
  `explicitModels`) govern `spawn_agent` alone. The page lists every
  provider's models from the host's live catalog (`catalog.get`, asked at
  each mount: the static rows, the probed ones such as Muse Code's, the Meta
  rows under claude and codex), an empty provider as one muted line, and a
  model the rules name that the catalog lacks as a muted "not on this host"
  row that keeps its policy (`staleModels` in lib/tcserver/rules.ts). A
  probed row the copy never decided reads its `defaultApproval`
  (`withProbedDefaults`, applied in `rules.get` and `rulesFor`, never
  written back, so the page and `spawn_agent` agree on each host); the page
  saves Off as `approved: false` so a decision is never taken for absence. The rules and the thread
  defaults have one copy, on the box: `remote/rulesSync.ts` on the Mac
  seeds each shared scope (global, and every workspace by `linkId`) from the
  Mac once, then follows the box on link-up, its `workspaces` push and
  every 5 minutes (a read sent before a forwarded write never lands over
  it), and sends `rules.set`/`defaults.set` there (refused while it is
  offline; the box stores a rule for a model it cannot run). `rules.get` and
  `defaults.get` answer `home { name, online }` when the copy is another
  host's: the Orchestration and Thread defaults pages print "Saved on box",
  or "box is offline" with every control off, and a refused write rolls
  back with a toast. Each host also knows what the others run
  (`peerCatalogs.ts`: `catalog.exchange`, admin, on every rules sync; kept
  under `catalog:peer:<envId>`), since one copy of the rules cannot make the
  box run Muse Code: the spawnable table lists another reachable host's
  approved rows this one lacks under that host (`- muse on <Mac>
  (environmentId: "mac"):`), `spawn_agent` and `app_start_thread` that name
  a host check the model against that host's rows (`hostCatalogView`), one
  that names none is refused with the environmentId that reaches it
  (`hostServing`), and `withProbedDefaults` reads every host's probed rows.
  Proof: `bun run script:e2e-rules-sync` (`TEMP_CODE_PROBED_CATALOG=<file>`
  answers an isolated instance's probes; docs/box.md "Orchestration rules
  and thread defaults: one copy, on the box"). `app_start_thread`, the
  cross-host `thread.start` and `session.create` check the catalog only (the
  named host's for a start there): the model exists for some provider, the
  effort is on its ladder (else refused, never clamped), `context1m` where
  offered. `spawn_agent`'s refusal of an orchestrators-only model and the
  approved table point a thread at `app_start_thread` for the same model as
  a thread.
- **The queue: `after` and the running cap.**
  `ThreadScheduler` (src/main/server/scheduler.ts) creates a thread
  `queued` (SessionStatusSchema: not live, never counted, never resumed by
  the liveness sweep) for two reasons. Its `after` sibling has not finished
  (met when the sibling is `done`, or `idle` after a turn, or archived or
  deleted; one that errored, stopped or paused keeps the waiter queued);
  only a root whose create opted in waits on `after` (`session.create
  { queue: true }`, or any thread with a `masterId`), on its first message.
  Or the host is at its running cap (src/main/server/admission.ts): the
  `admission.maxRunning` setting when pinned, else floor((budget − reserve)
  / perProcess), budget the smaller of the cgroup's memory.high/max and the
  machine's memory, reserve the larger of 25% and 8 GiB on Linux (50% and
  16 GiB on macOS), perProcess the median harness RSS read every 60 s (450
  MB until five readings); admission also pauses while available memory is
  under 10% of the budget (MemAvailable on Linux, `kern.memorystatus_level`
  on macOS: os.freemem() there counts only never-used pages). Slots are
  counted by handle: every harness up or booting counts (`handles` ∪
  `starting`), whatever its row says, and a running or watching row with
  no harness (a zombie the liveness sweep has not reached, a master Stop
  idled) holds none. That is, every live
  harness counts, roots and subagents, in starting, running, waiting or
  watching (unarchived), plus every row still holding a handle; warm
  processes and queued rows never do. The count and the queue come from the
  session index (sessionIndex.ts `live` and `queued`, roots and subagents)
  and the live handles: a pass reads no sessions table. The cap applies to every start: create's eager
  boot, a first message, a send on a thread whose handle is gone, a
  `spawn_agent` child (created `queued`; `wait_for_agent` waits through
  queued and starting; spawn, `list_agents` and `check_agent` say "queued ·
  120 of 120 running"). `admit` decides in `SessionRegistry.send` (the user
  row and its preamble stamp land as a held-back boot stores them, the
  message waits at the front of the thread's queue marked `stored` on the
  wire, so the composer's queue skips it and the transcript's row is its
  one appearance); `startQueued` (the
  scheduler; `session.start { sessionId }`, operate, the strip's Start now,
  past `after` and past the cap) sends it through the same path; a focused
  send is admitted over the cap, up to two (`scheduler.focused`, wired
  to the host's FocusSet). `tick` runs oldest-first (createdAt, then
  the order the scheduler queued them in) on every meta change and removal and after boot once the BootResumer is done
  (`holdUntil`); a pass reserves the slots of the starts it picks before
  launching them, and while rows wait on the cap it puts down the
  longest-idle harnesses (`reclaimIdle`, 3 s grace, never one with a pass,
  queued messages or reports due), which is how a settle frees a slot. The
  BootResumer resumes up to the cap and leaves the rest `queued` with their
  nudge stored (`queueResume`; their ledger rows stay). A queued row's
  `statusDetail` reads "Waiting for <sibling>" ("(errored)" /
  "(stopped)" / "(paused)" appended), "120 of 120 running" or "Waiting
  for memory" (scheduler.ts `QueuedLine`), and its `activity` the legacy
  "Queued  waiting for memory" for old readers, pushed only when it
  changes; `list_agents` says "queued: 120 of 120 running". RPCs
  `admission.get` (read: cap, pinned, default, running, queued, memory) and
  `admission.set { cap | null }` (admin); a Running threads row in each
  connected host's section of Settings → Hosts shows it
  (surfaces/settings/hosts/Admission.tsx). The
  fleet's Stop and Archive done take a queued root as "remove from the
  queue" and archive it.
- **The batch's rules are a steps list the master writes, and the engine
  runs it** (src/main/server/batch.ts, src/shared/contract-batch.ts
  `BatchRulesSchema`): `land` as-they-finish (merge_branch fast-forwards
  each child's branch as it lands) or all-at-once (merge_branch answers
  "HELD: the batch lands all at once; the master will merge <branch> when
  every thread is done", records the branch, and the engine merges the
  held branches in landing order at the end); `steps: BatchStepSpec[]`
  (`{ id, name, kind, run?, cwd?, when? }`, at most 32) in the order they
  run; `then` notify (a `batch` notice row on the master and a wake) or
  archive-children (the same, and every done child archived); and one
  `summary` line in the master's words. The kinds: `land` (always first;
  a list without one gets it); `gate` (the commit tier once on the project
  checkout at the project branch's head); `release` (`bun
  scripts/release.ts --notes-file <tmp> --push`, the notes the master's
  title then each landed subject's first line, cut at whole subjects to
  16 KiB with "… and N more" (`boundNotes`, `RELEASE_NOTES_MAX` in batch.ts),
  written to a file under the tmp dir that gateRun.ts removes when the run
  ends: the tag, and master with it pushed to origin; with nothing new since the last
  tag the step is skipped as "nothing to release since release-N" and a
  publish or deploy after it takes that version); `publish` (the Mac's publish job
  for that commit over the peer link, "Releases" above; a person's
  decision); `deploy` (the box's deploy trigger of docs/box.md "Deploy from
  the app": `v1.0.N` when a publish passed, `master` otherwise; skipped as
  "needs a release" when no release step comes before it); `shell`
  (`run` through the login shell in `cwd`, default the project checkout,
  on the GateQueue in its own process group, stdout and stderr streamed
  into the step's `log`, exit 0 passes; `when: 'each-landing'` runs it
  again after every landing, serialized, and leaves it out of the end).
  `stepsProblem` refuses a repeated or bad id, two steps of one built-in
  kind, a shell step without `run` and `run` on anything else. Default:
  land, gate, release. The master writes the list with the `batch_rules`
  app tool (master only; codex over the bridge as `app.batchRules`;
  MASTER_MECHANICS says to write the steps that fit the project, for a
  Minecraft plugin build, deploy to the dev server, smoke test, for this
  app gate, release, publish, deploy, and to state them to the person), a
  person over `batch.setRules { masterId, rules }` (operate, a partial);
  a new list keeps the telemetry of every step whose id and kind stay.
  The engine runs when the last child is done (every unarchived root
  carrying the masterId is `done`, or `idle` with a turn completed,
  `Store.hasCompletedTurn`, and no subagent still working: an idle root
  over live subagents is watching, not done, and Archive done leaves it); an errored or stopped child blocks the end,
  and so does one idle on a turn that ended in a failure (its row's
  `failure`, a usage cap; `blocked.why` `failed`; a paused child `paused`, one idle on a turn it never completed `no-turn`, or `interrupted` ("was stopped") when a person's Stop ended that turn, `Store.lastTurnStopped`), `blocked` names it and
  the master is told once as a `<batch-report>`. A red gate or release
  step's `detail` is the step the gate names as failing and its first
  error line, or that line alone when nothing finer than the row's own
  step failed, so the row's name is never said twice
  (`gateFailureDetail`, src/shared/gate.ts; the runner keeps the first
  error line past its tail), no duration, and the gate notice carries the
  same words as `GateNotice.detail`; a failed step whose log only repeats
  its detail opens no console (`hasConsole`, master/steps.ts). `describeTool` (sessions.ts) words
  every tool the strip can meet, the CLI's task tools, the app's and the
  orchestrator's included; an unknown name is humanized, never printed raw.
  Steps run in order on the host's `GateQueue`, a gate or release outcome a
  `gate` notice row on the master; a red step stops the rest and tells the
  master; the steps after land run whenever the batch ends, on the project
  checkout at the project branch's head, however the branches got there (a
  child that fast-forwarded the branch itself never called merge_branch;
  "nothing landed" is the land step's detail, never a reason to skip the
  rest; only deploy without a release step before it is skipped, as "needs
  a release"); the land step counts only threads with a branch to land
  (`canLand`: implementation and orchestration, a chat or research thread
  once it landed or holds one, a planner never); a planning child whose
  plan is complete holds the batch open until its build exists. The end
  runs once per cycle: at all-done when it never ran, or when since it last
  started a landing came in (landed, held, or reported by a far host), a
  child joined that was not in the batch then, or the rules were set
  (`batch_rules`/`batch.setRules`, even unchanged: the hand re-run); a
  child resuming and settling idle again, a child leaving or a failed step
  never starts it (`armed`, `ranChildren` on the row), so a failed publish
  never cuts a fresh release on the next idle. `batch_gate` stays the master's way to run
  the gate and release steps early, with children still out left out of
  the land step (refused when the list names no gate). The deploy restarts
  the box's own process: the row is persisted before the trigger fires and
  `Batches.resumeAfterBoot` (after the BootResumer) closes the step from
  the trigger's exit file, runs the steps after it and `then`; any step still
  running at a restart but a deploy it can follow (gate, release, land
  and shell alike) is failed as such, the master told. `batch.stopStep
  { masterId, stepId }` (operate) kills a running shell step's process
  group or stops the Mac's publish job. Seam: `TEMP_CODE_GATE_STUB=<json>`
  (rules `{ step, branch?, ok, log? }`) decides a gate or release step
  without spawning.
- **Step telemetry on the wire.** `BatchState` (`batch.get`, `batch.board`,
  and the pushes, coalesced to four a second while a log streams) carries
  `rules`, `steps`. Sockets watching that master (boardWatch.ts) get
  `batch-delta`, each step's log as `{ from, lines }` since the last push;
  a socket that never asked `batch.board` (the phone's `BatchPush`) gets
  the whole state as `batch`. `steps` is the list
  in order, each `{ id, name, kind }` with `status` pending | running |
  passed | failed | skipped, `detail`, `startedAt`, `endedAt`, `progress
  { done, total, label? }` (land: branches merged of total; gate: the
  tier's steps done with the running one as label; publish and deploy:
  their stage) and `log` (the newest 200 console lines; a shell step's
  opens with `$ <run>` and ends with its outcome), plus `landed`,
  `pending`, `held` (all-at-once), `blocked` and `finishedAt`. The board's
  foot draws a live console per running step from exactly these.
- **The master stays live until the batch is done.** A master whose batch
  is open (`Batches.open`: children exist and not all are done, or the
  engine is at work) takes `watching` in place of `idle` when its turn
  ends: the harness stays up, the queue and the completed-turn pass drain
  on that watching as on idle, the boot ledger keeps it so a restart brings
  it back (into a turn, then watching again), and the batch closing idles
  it (`registry.masterIdle` when nothing is coming). A dead harness under a
  watching row is settled the moment the driver's stream ends
  (`harnessGone` → `settleGoneHarness`), the liveness sweep being the
  fallback past the grace: a master kept watching by its batch reads
  `stopped` with its clock at zero (Resume boots a fresh harness with the
  restart nudge and a clock that starts then; the parked reports follow at
  its settle), a thread watching its own background work settles idle, a
  report to a dead watching master boots a fresh harness (`drainReports`); Stop and
  Kill background tasks on a watching master idle it for real (a one-shot
  `stopWatching`), unpinning idles it, and `liveIds` counts handles and
  boots only. `decorate` gives a watching master its batch's reason ahead
  of the watch line ("Blocked: A errored", "Blocked: A ended its turn
  without completing": `blockedWords` in src/shared/batchWords.ts, which the
  board's foot and the phone say too) and every meta carries
  `lastEventAt`. A batch that has not moved for `STALE_WATCH_MS` (30 min:
  the children's last rows, a far child's last settle, the steps, the
  master itself) while its master watches unblocked is told once as a
  `<batch-report>` naming every thread with its state and age
  (`Batches.checkStalls`, every minute, the stamp on the row), and again
  only after the batch moves and goes quiet again; a blocked batch is not
  a stall.
- **A message to a live thread goes straight in.** To a watching master it
  starts a turn at once (the idle path). To any thread mid-turn and not
  paused, `queueAdd` whispers it into the live turn as a `<user-steer>`
  with its user row kept (`steerLive`; attachments still queue; the
  composer's Enter steers by default, `MID_TURN_DEFAULT`; `queue.add`
  answers `queued` with its item or `steered` with its id); a whisper into
  a dead handle boots a fresh harness that gets the text once; a provider
  that cannot take mid-turn input, or any other failure to hand it over,
  front-queues it. Every person's steer (the composer's, a queued item's
  Send now, attachments and all, the phone's; never `send_to_agent`)
  carries a `steerId` on its user row, and `steer { steerId, state, how?,
  reason? }` rows say where it stands (src/shared/events.ts; the last row
  wins): `sent` once the harness has it, `received` when the model read it
  (claude: the CLI lists the id, sent as the SDK message's uuid, in
  `user_message_uuids` on the frame after the fold, drivers/claude.ts
  `readSteers`; codex: `turn/steer { expectedTurnId, clientUserMessageId }`,
  falling back to `turn/start` with the id when the turn ended, and the
  `userMessage` item carrying it as `clientId`), `in-turn` or `next-turn`,
  `queued` while it waits for the next turn, `failed` with the reason when
  it never reached a model. A driver without `confirmsSteers`, or a steer
  still at sent when its turn settled, is received at the next turn's
  first output (`steerFallback`). The text goes in as `wrapSteer` (the
  `<user-steer>` block and one line asking for a one-line answer first;
  `STEER_MECHANICS` says the same beside the notes mechanics in every
  prompt). Under the bubble the transcript says one 12px word, Sent,
  Received, Queued for the next turn or Not delivered, its time and how in
  a tooltip (transcript/UserMessage.tsx `SteerLine`, lib/steerWords.ts);
  the phone the same (`SteerStamp`, TranscriptRows.swift; its time is the locale's clock, `TimeFormat.clock`). The CLI reads a
  steer only at its next model request, after the call it is running or
  the compaction it is in (the box, 2026-11-06: one waited through a 600 s
  Bash call, one through a 3 min gate; nothing was open at the provider),
  so a send into an open turn announces nothing (`announcesSend`,
  drivers/claude.ts: no `running`, no `waiting-provider`, no first-output
  watchdog), a `running` repeated on a running row keeps the turn's
  activity, and while a confirming driver's steer is unread the row reads
  the turn's own word with the message behind it, "Running the gate, then
  your message" (`thenYourMessage` in shared/statusWords.ts, `steerUnread`
  in sessions.ts; a Bash call is named by its first command past a `cd`,
  an `export` or a `NAME=value`, `commandLead`), never a provider wait of
  its own. Proof: `bun run
  script:e2e-steer-ack` (docs/box.md "A steer says it was received"). And a send releases the
  thread's pending `wait_for_agent` as the steer does
  (`resolveSteerWaiters`): a master's wait in flight returns
  `{ status: 'steered', message }` in every mode, never swallowing the
  person. A settle, idle or watching, takes what waits as one turn
  (`drainSettled`): the held notices, the parked reports, the person's text
  last; a report never wakes the thread alone while text waits.
  MASTER_MECHANICS prefers ending the turn and being woken to blocking
  waits.
- **Pause cascades.** `session.pause` on a master pauses every root of its
  batch on this host (four at a time through sessionBatch.ts
  `batchChildIds`), `session.resume` resumes them, Stop stays per thread;
  the paused banner folds those children under the master as "and N batch
  threads with it", and the master's own strip says the same when it is
  on screen. A board view (master, plan, implementation, research) whose
  chat is folded draws the thread's paused row under its header
  (SplitShell `held`, `heldRowOf`), never while the chat shows.
- **The gate out of the children** (src/main/server/{gateQueue,gateRun}.ts,
  src/shared/gate.ts, docs/review-before-merge.md): `merge_branch` gates
  the branch after the optional review and before the fast-forward: a
  batch child runs `bun run typecheck` alone in its worktree (a break is
  named to its thread); a thread outside any batch runs `bun
  scripts/gate.ts --tier commit --since <merge-base>` there. A red run
  answers "HELD: typecheck failed on <branch> · 3 errors", the last 20
  lines, "call merge_branch again", and lands a `notice` row of kind `gate`
  (`GateNotice`, surfaces/GateCard.tsx). The gate's hub, ios, ios-client and
  computer-swift steps are `mac: true`: a host off macOS (the box's merge gate, the box's
  release step) skips them with a note, and the Mac's publish gate runs
  them before anything ships. The house preamble (`HOUSE_PREAMBLE`) tells a
  thread to run typecheck and the tests it wrote or touched, never the full
  suite or the build, and to land with `merge_branch`.
- **The view** (docs/LAYOUT.md "Master"): `MasterView` (surfaces/threads,
  routed when the session's `isMaster` flag is on, whatever its type;
  `isMasterThread(session)` and `useMasterIds()` in lib/masterThread.ts,
  the tab's and the rail row's "Make master thread" / "Remove as master" over
  `session.setMaster`) on the SplitShell recipe, the board left of the
  master's chat while the batch has a row or a step runs (`boardShown`);
  with nothing in its batch the master is its transcript alone and its
  thread menu holds New batch thread… and Add existing thread…
  (`BatchAddDialog`, the same dialogs as the board's + menu); a board
  that arrives live opens the chat and fades in, one that empties leaves
  at once. The board, its rows, the foot, the dialogs and the add
  sheet are surfaces/threads/master/**. The rows are the children on
  every host the renderer knows (the session store holds each connected
  or mirrored host's rows; `batch.get`'s `children` list, when the host
  sends one, overrides a row's host and status, `mergeBatchChildren`); a
  row on another host than the master's carries that host's glyph after
  its title, its name on hover (`rowHost`), and sits under the
  offline tint while that host's link is not open. A child the store has
  no row for draws from a whole stand-in meta (`standInMeta`: the list's
  provider, model and effort, the rest at rest; no model, no model mark).
  Each row sits in its own `RowBoundary` (master/RowBoundary.tsx, the
  ChunkBoundary pattern): a row that throws paints "Couldn't load" and
  Retry at its height, its siblings, the board, the rail and the
  transcript stay, and stalls.log's `[renderer] caught` line ends
  `thread=<master> row=<child>` (`tagRendererError`). The board sits in
  one more boundary (`MasterView`'s, `failed` on ChunkBoundary): a board
  that throws outside a row leaves the master as its transcript alone
  under "Couldn't load the board" and Retry (`BoardFailed`), tagged
  `thread=<master> view=master`. A plan that started several builds lends
  its row to the first and each later build is its own row (`foldRows`):
  rows never share a key, which kept `useBoardLayout`'s snapshot from
  settling (React #185 on "Update 35 more"). A row is 48px, two
  lines on `Item` with every left edge of the board 12px in
  (master/MasterRow.tsx, the rule `rowStatus` in master/rowBody.ts):
  the type glyph (its word in a tooltip), the title, the host glyph and the
  model mark (provider mark, model and effort, "Opus 5.5 High"; the whole
  model, effort and context in its tooltip; the title gives way first);
  then `StatusMark`'s glyph hanging under the type's (working's spinner the
  row's one moving mark; none for done or idle) and in the title's column
  the word where the section does not say it, then what the state is
  about (the task in hand, the question or "Approve Bash" in amber, the
  failure in red; "Landed 12:08 PM" (lib/duration.ts `clockTime`, the app's one clock time: 12-hour with AM/PM where the locale writes it) or a settled research thread's summary;
  the child the batch's `blocked` names says why, "Ended its turn without
  completing"; a watching or paused child under Working, a failed one
  under Needs you, says its own word) and the task tally `3/7` at the end; the sections read Needs you, Working, Queued,
  Done with no counts. An implementation or orchestration row with tasks
  is 64px until it is done (a finished one is 48px, its tally back at the
  end of line two, none once every task is ticked): a third line holds the task bar (`Progress`, foreground while
  working, muted otherwise), the tally said there alone and a chevron
  right after it; every bar on the board is one width, 35% of the board
  pane (`@container` on MasterView's `data-board-pane`, the bar
  `w-[max(160px,35cqw)]`, no cap: a column too narrow shrinks the bar),
  the whole line folding the task list open under it (`TaskRows` compact;
  open by default while the thread is live, folded with the line on
  `.collapsible-auto` `FOLD_HOLD_MS` after it reaches Done, once, at that
  transition, `useFoldHold` in lib/foldHold.ts; the person's choice wins
  both ways, remembered per row for the window's life in
  master/taskFold.ts; `taskBar` and `taskProgress` in master/rowBody.ts).
  On hover the model mark gives way to Message, the state's one verb
  (Pause, Resume, Start now) and ⋯, the row's menu, where Stop, Archive
  and a queued thread's Remove from queue live. A row whose thread has
  live subagents lists them under its two lines, one line each: the status
  glyph drawn still (working as a dot), the title, the state's word in its tone and what it
  is about, muted, in the board row's own words (`rowStatus`), and the
  host's glyph, no role glyph; the
  whole tree by the parentId chain, archived ones out, a far child's from
  its host's rows, the person's first (waiting, failed, working, then
  paused or queued), at most three, then one quiet "2 more, 3 done";
  agents that all settled show nothing. A line opens the agent in the
  board's place like a row (`underRow` keeps it open)
  (`master/agentSummary.ts`: the session store keeps a parent index and
  reports changed ids with their old and new ancestor chains once per
  flush; only affected rows rebuild their summaries, and a row
  re-renders only when its own lines changed. Summaries and digests prune
  children that leave the board; the phone's
  `MasterBoard.rowAgentLines` the same, each line a link to the agent's
  thread screen, the tail "2 more, 3 done"). A row's click puts the
  child's full view in the whole pane with one Back control
  (`master/ChildPane.tsx`, given the row's host; Escape and ⌘↩ outside
  the composer go back; the board keeps its scroll; the header is Back and
  the title, drawn at once from the board's row, the body the transcript's
  skeleton until the rows load; a board-type child's view draws one header,
  its own, with Back leading it, surfaces/threads/viewBack.tsx), over the same
  transcript, strip and composer a tab has (`surfaces/threadChat.tsx`:
  `ThreadComposer` and `useThreadChat`, shared with SessionPane; App's
  handlers through `SessionActionsContext`). A right-click on a row or a
  subagent line, or its ⋯, is that thread's one menu (lib/threadMenu.ts
  with `{ open, newPass }`: Open, New pass…, Start now for a queued
  thread, then the rows every surface shows, Remove from queue in a
  queued thread's Archive place; chrome/useThreadMenu.tsx answers the
  picks); New pass… is a Modal (`master/NewPassDialog.tsx`) with the
  thread's title, its status and activity or last words on one line
  (`passLine`) and that composer, closing on send; the draft stays per
  thread. The title bar's ⋯ menu is the batch's
  fleet switches over every host (Pause all and Resume all through each
  row's host's `session.batch`; Archive done… and Archive all… with the
  live count (done by the host's own rule, `BatchState.done`, the far
  children as `<env>:<id>`; an older host's answer falls back to done or
  idle less the blocked child) and the resources checkbox: `batch.archive` on the master's
  host, then each other host's `session.batch` for the rows its answer
  left, `remoteArchivePlan` in `master/boardActions.ts`), + (Add thread) a menu
  with New thread… (the add sheet: every type, Chat first; Host over the master's host and every
  linked one, `linkedHosts`; `session.create` on that host with
  `masterId` and `startedBy` = the master) and Add existing thread…
  (the project's roots in no batch on this host and its paired copies,
  `pairedProjectIds`; one `batch.adopt` on the master's host, a remote
  thread as `<envId>:<id>`, refusals read back in the sheet). The board's
  header is SplitShell's: the master's title (14px semibold), the batch's
  done tally (`doneTally`, "3/7", the rail card's count), then ⋯, + and
  the conversation toggle as equal 28px icon buttons; the master's
  summary stays in the rules dialog. The foot is rows: "When done" with Edit, one row per step
  (`StatusMark` through `stepState`, the name, `stepDetail`, the time,
  Stop on the running one), the running step's console opening under its
  own row (`Collapsible`; a shell step's command shows once, as the
  console's first line), and "Then notify you" or "Then archive the
  threads"; the rows paint from the store at once and only the foot is a
  still `Skeleton` until `batch.board` answers. The foot and the
  rules dialog read the steps as the master's
  list: `master/steps.ts` joins `rules.steps` with `state.steps` by id (a
  step the rules name that the host has not seen is pending at the end),
  Stop is `batch.stopStep { stepId }`, and the dialog
  (`master/rulesEdit.ts`) reorders, renames, adds a built-in kind or a
  shell command with a cwd and removes steps, land pinned first with no
  move or remove of its own (`normalizeSteps`, `pinned`); no step name is written in
  the renderer. A menu or popover sits on the popover layer
  (`--layer-popover`), above every dialog. `lib/threadBatch.ts`
  exports `hasRunningTurn` so the rows and Pause all use the fleet
  switches' rule. The phone draws a queued root with the label "Queued"
  (StatusDot.swift), never under Home's Running (`HomeModel.isLive`); the
  strip offers Start now (`session.start`) and a stopped root Resume; the
  fleet switches sit in the host's and the project's menus
  (ios/TempCode/Sources/Shell/FleetSwitches.swift over the client package's
  ThreadBatch.swift); a master opens on its Board segment ("The iOS
  client" below).
- **The rail houses the batch under the master's row** the way subagents
  sit under a root (`batchHome`, `railMasters` in lib/workspaceSessions.ts):
  each unarchived root carrying the master's id is a `batch` row (apart
  from the master's own subagents in `children`; a list row shows the batch
  first, then the subagents, folded behind "N threads"), each with its own
  subagents under it; a plan whose build has started takes no row
  (`startedPlan`), an archived thread never does, and a batch whose master
  is archived or unpinned shows as plain roots, in the strip as on the
  rail (`batchHome`, lib/threadStripModel.ts). In the workspace column a
  project's card draws a master's batch as one block under the master's
  line, which ends in the batch's done tally (`3/7`; `cardLines` in
  lib/sidebarRows.ts, `MasterLines` in chrome/WorkspaceSessions.tsx; a
  working batch line draws a dot and the master's line spins while its
  block works (`MasterBlock.lead`), one moving mark per block); the
  workspace popover (a rail row's word)
  keeps a master as one block (`masterBlock` in lib/sidebarRows.ts,
  `MasterRows` in chrome/WorkspaceThreadsPopover.tsx): the master's row
  with the tally, its own working subagents under its title in the fleet's
  words, then each batch thread that works, waits, failed, paused or
  stopped one step in, loudest first, its working subagents under it, and
  the queued ones as one "N queued" line; settled ones are the tally.
  Nothing inside a master is unread (`housedIds`: the batch and every
  subagent of the master or of its batch): no weight and no count in the
  project card, the rail row, the popover or Mark all read; the master
  keeps its own. They still light their project's and workspace's Needs
  you and Working (`groupMark` over `cardThreads`).
- **Proofs and tests.** `bun run script:e2e-master-batch`
  (scripts/e2e-master-batch.ts: the whole flow in one process, a haiku
  master pinned with `session.setMaster` beside a second master of the same
  project, writing its steps with `batch_rules` (a shell step last) and
  starting four children of three types with one `after`, a thread a child
  starts inheriting the batch, `batch.adopt` and its refusal, settles,
  `answer_agent`, a land held then merged, a Fable THREAD started from a
  plain chat and a Fable SUBAGENT refused it, the engine ending the batch
  by its steps and idling the master, `batch_gate`, `batch.archive done`),
  `bun run script:e2e-queue` and `bun run script:e2e-batch-gate`; none in
  the gate (they boot harnesses). Unit tests: rules, orchestration (master
  section, the refusal wording, the steer, `settleTargets`,
  `batchMembershipOf`), apptools (no policy for threads, the inherited
  batch), remote/crossHostThreads (the batch over `thread.start`),
  db-master (the flag, the one-time copy of the project pin), scheduler,
  threadBatch, gateQueue, gateRun, mergeReview, batch (the steps list and
  its refusals, the legacy row, shell steps passing, failing, stopped and
  each-landing, adopt, archive, the blocked case, the telemetry, the push
  throttle, the deploy's restart), sessions-master (the watching master,
  the steer, the cascade, the batch following the starter, `setMaster`,
  archive), sessionBatch, planFlow, projectPreamble, contract-batch, the
  peer publish on both sides (remote/macPublish, remote/peerPublish,
  contract-publish); the renderer's useMasterModel, MasterView.dom,
  GateCard.dom, TabIndicator.dom, ThreadBanners, ThreadHeader,
  WorkspaceSessions.dom.