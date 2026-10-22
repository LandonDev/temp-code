# Master threads

A master thread starts, watches and steers a batch of root threads. This
is the long account: why the shapes are what they are, how the pieces fit,
what is on the wire, and what proves it. CLAUDE.md "Master threads" is the
short one.

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

The fix is a role, a queue, one gate per batch, and (wave 3, after a day
of use) rules the master sets and the app runs when the batch is done. A
running cap and a model policy on threads were tried in wave 1 and taken
out again: the cap only made a batch slower than its slowest thread, and
a thread is a person's choice whoever starts it. Wave 4 came from one
more day: a planner the master had started called `app_start_thread` for
its own build, and the build left the board, since only a master's own
starts carried the batch; the pin on the project row kept a project to
one master; the fixed five steps said nothing a Minecraft plugin's master
could use. So the batch follows the starter, the pin is on the thread,
and the steps are a list the master writes.

## The master is a role, not a type

A root thread is pinned as a master on its own row (`sessions.is_master`,
`SessionMeta.isMaster`). Any root thread can be it; in practice a chat;
several threads of one project may be, each with its own batch keyed by
its id (one master per release train, another for a side quest). The pin
is "Make master thread" / "Not the master" on the thread's context menu
(the rail row and the tab) and the RPC `session.setMaster { sessionId,
master }` (admin; a subagent is refused). Clients hear it as the thread's
meta push. The master's tab reads one muted "Master" after its title;
nothing else in the rail marks it or its children. Until wave 4 the pin
was `projects.master_thread_id`, one per project; a database from then
copies that pin into the flag the first time `is_master` is added
(db.ts) and the column is ignored since (it stays: master only adds).

`isMasterSession(session)` reads the flag off the live row when the
registry knows the id, not off the object it was handed. Why: the harness
boots eagerly at `create`, before a person pins the thread, and the tool
closures the driver builds hold that first meta; the batch tools are
attached at spawn (after the driver's own awaits) and the supervision
tools check the caller on every call, so a thread pinned a moment after
it was made still gets `batch_rules` and still supervises its batch. A
thread pinned long after its harness booted gets the tools at its next
spawn (a Continue, a restart), as the edit denial below.

A master is an orchestrator under the one rule that still asks, the
subagent model policy: `policyRoleOf(session, master)` in
src/shared/rules.ts answers `'orchestrator'` for an orchestration thread,
an orchestrator agent or a master, and `policyRole(session)` in
orchestration.ts reads the flag, so a master may `spawn_agent` Fable
where a chat may not. Its prompt carries `MASTER_MECHANICS` through
`mechanicsFor`, and the claude driver denies it Edit, MultiEdit, Write
and NotebookEdit, as it does an orchestrator without self-edit: the
master steers, the batch edits.

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
own row (housed under the master's in the rail, one step in like a
subagent's: `batchHome` in lib/workspaceSessions.ts; a plan whose build
has started takes no row, the build is the row), its own view and its own
notes, and outlives the master's turn. What the master gets is supervision by id:
`supervisedBy(caller, session)` is the one check every supervision tool
runs, and it admits the caller's subagents plus, for a project's master,
every root thread on this host that carries its id. The refusal reads "is
not a subagent or batch thread of this session".

**The batch follows the starter.** `batchMembershipOf(starter)`
(orchestration.ts) is the one rule: a thread a master starts carries the
master's id; a thread a batch root starts inherits that root's
`masterId`; a thread anyone else starts carries none. `startedBy` stays
the caller in every case. It runs in `app_start_thread` (with `after`
when the thread is in a batch), in the cross-host `thread.start`
(`crossHostAgents.startThread` puts `masterId` in the args and the other
host stamps it with the caller as `startedBy`; the ids are the caller's
host's, so that host reports to neither and the caller's host supervises;
the asking side indexes the thread under the master, so the engine there
counts it, docs/box.md "A master's batch across hosts"), and in
`SessionRegistry.create` whenever `startedBy` names a thread and the
caller gave no `masterId`, which is what `session.create` from a thread
and the plan flow's auto-started build go through (planFlow.ts also
passes the plan's `masterId`, `after` and `startedBy` explicitly). From
the board, "+ Thread" opens the add sheet (type, model, effort, context,
host, after, brief) and passes `masterId` and `startedBy` = the master
itself, on whichever linked host was picked. Why the starter and not
the project: the case that broke was a planner the master had started
calling `app_start_thread` for its build (hand-off `how: manual`); the
build had `startedBy` = the plan and no `masterId`, left the board, and
its settles went to the plan alone. `list_agents` marks each row
`subagent` or `thread`; a batch row carries its type, model, effort, host
and status.

**Adopt and archive.** `batch.adopt { masterId, sessionIds }` (operate)
brings existing unarchived root threads of this host into the batch:
each takes the master's id and, when it had none, the master as
`startedBy` (`registry.setBatchMembership`), the master gets the `batch`
push and hears the thread's next settle. Refused, each with its reason:
the master itself, another master, a subagent, an archived thread, a
thread of another batch, an unknown id. The master does the same with the
`adopt_thread { threadId }` tool (codex over the bridge as
`app.adoptThread`). `batch.archive { masterId, which, removeResources? }`
(operate) archives the batch's children and leaves the master: `done` is
the done ones (done, or idle after a turn), `all` is every one with the
live ones stopped first; both go through the fleet's own `session.batch`
(sessionBatch.ts, four at a time, the resource cleanup when asked).

**Settles.** A thread settling (idle, error or waiting, never a pause)
reports to everyone in `settleTargets`, once each: its parent, else its
master (`settleTarget`), and the thread that started it (`startedBy`)
when that is someone else. So a build the master started reports to the
master once; a build the plan started reports to the master (it is in
the batch) and to the plan (it started it), each once; a thread a plain
chat started reports to the chat. `notifyParentOfSettle` writes the
`<subagent-report>` that names the thread, its status and its last
words, and for a waiting thread the question with its `requestId`, so
the master answers it with `answer_agent`; a target that is archived or
gone hears nothing. A `wait_for_agent` in flight takes the settle instead
of a report. A plan child's plan-complete report (planFlow.ts, to its
starter) is its one report, not two. Two threads naming each other as
master wake neither. Children on other hosts are not supervised yet.

## The queue: `after` alone

A thread whose `after` sibling has not finished is created `queued` and
started later, never refused. That is the one reason to queue; wave 1's
running cap (`threads.maxRunning`, four by default) is gone with its RPCs
and its Settings field. Why: a cap made a batch wait on slots the box did
not need freed, since the load the feature exists to end was the gates,
not the harnesses, and the gate now runs once. A person who wants fewer
threads at once starts fewer.

`ThreadScheduler` (src/main/server/scheduler.ts) owns the decision.
`after` is met when the sibling is `done`, or `idle` after at least one
turn, or archived or deleted; a sibling that errored, stopped or paused
keeps the waiter queued and its line says so. Only a request that opted in
queues: `session.create { queue: true }`, or any thread with a `masterId`;
a person's own new thread starts at once. The decision is `admit` on the
FIRST message in `SessionRegistry.send`, which every start path ends in:
the user row and its preamble stamp land exactly as a held-back boot
stores them, the status goes `queued`, and the message waits at the front
of the thread's queue. `startQueued` (the scheduler when the sibling
settles; `session.start { sessionId }` from the strip's "Start now", past
`after`) sends it through the same path, `queued` → `starting`; after a
restart the first user row is the message. `tick` runs oldest-first on
every meta change and removal, and after boot only once the BootResumer
is done (`holdUntil`).

A queued root's `activity` reads "Queued · waiting for <sibling>"
("(errored)", "(stopped)" or "(paused)" appended), pushed only when it
changes. The rail draws a still gray dot, the tab edge "Queued" with that
line as its tooltip, the working strip the line with "Start now". The
fleet switches' Stop and Archive done take a queued root as "remove from
the queue" and archive it (lib/threadBatch.ts); Pause and Resume leave it.
The boot resumer and the liveness sweep never touch it.

## The policy is for subagents

The model policy's `approved` is `true`, `'orchestrators'` or `false`
(src/shared/rules.ts). `modelApproved(rules, provider, model, role)` lets
an `'orchestrators'` model through only for an `'orchestrator'` role.
Settings → Orchestration's model row reads Everyone / Orchestrators only /
Off. Fable (`claude-fable-5-1`, `claude-fable-5`) defaults to orchestrators
only in `DEFAULT_RULES.models`; a saved rules object replaces the whole
map, so a database with its own entries keeps them.

Only `spawn_agent` (`resolveSpawnSpecs`) checks it, with the caller's
role. A thread is a person's choice whoever starts it: `app_start_thread`
(`appStartThread`), the cross-host `thread.start` that goes through it,
`session.create`, a plan → build hand-off and the phone's New thread check
the catalog alone: the model exists for some provider (a gpt model asked
for under provider "claude" routes to codex; only a model no provider
serves is refused), the effort is on the model's ladder (else refused,
never clamped), `context1m` only where offered. Wave 1 had the policy on
`app_start_thread` too, so a chat was refused Fable for a thread it could
start by hand from the composer; that asymmetry is what went. The refusal
`spawn_agent` gives for an orchestrators-only model names the model and
the role and points at `app_start_thread`: "may not spawn it as a
subagent. Pick an approved model, or start the work as a thread with
app_start_thread (threads follow no model policy), or ask the user for an
orchestration or master thread"; `spawnableModels(rules, role)` marks the
rows "(orchestrators only)" for a `thread` caller with the same note.

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
own PATH, and drops the post-commit hook's `GIT_*`. The gate's hub, ios
and ios-client steps are `mac: true` (scripts/gate.ts `macOnlySkips`): a
host off macOS skips them with "needs the Mac; release:publish runs it
there" instead of failing on a missing swift, so a contract change lands
through the box's merge gate and the box's release step; the Mac's
publish gate runs them before anything ships.
`TEMP_CODE_GATE_STUB=<json>` (rules `{ step, branch?, ok, log? }`) decides
a gate or release step without spawning, for the proofs.

The house preamble (`HOUSE_PREAMBLE`, projectPreamble.ts) tells a thread
to run typecheck and the tests it wrote or touched, never the full suite
or the build, and to land with `merge_branch`; a saved workspace default
still equal to the old text is rewritten once (`migrateHousePreamble`,
marker `preamble-migrated:batch-gate`), an edited one is left alone. The
post-commit hook's train is unchanged.

## The rules, and the engine that runs them

What happens when the batch is done is the master's decision and the
app's work. `BatchRulesSchema` (src/shared/contract-batch.ts):

| rule | values | default | what the engine does |
| --- | --- | --- | --- |
| `land` | `as-they-finish` \| `all-at-once` | as-they-finish | merge_branch fast-forwards each branch as its thread lands; or answers "HELD: the batch lands all at once; the master will merge <branch> when every thread is done", records the branch, and the engine merges the held branches in landing order at the end |
| `steps` | `BatchStepSpec[]`, at most 32 | land, gate, release | the steps in the order written, each by its kind (below) |
| `then` | `notify` \| `archive-children` | notify | a `batch` notice row on the master and a wake; or the same, and every done child archived |
| `summary` | one line | — | the rules in the master's words, e.g. "Land all seven, gate once, release, then tell me" |

A step is `{ id, name, kind, run?, cwd?, when? }`: an id unique in the
list (letters, digits, dots, dashes), the name the board shows, and a
kind:

| kind | what the engine does |
| --- | --- |
| `land` | the landings; always first (a list without one gets `{ id: 'land', name: 'Land' }` at the front) |
| `gate` | `bun scripts/gate.ts --tier commit` once on the project checkout at the project branch's head |
| `release` | `bun scripts/release.ts "<master title; landed subjects>" --push`: the tag, and master with it, pushed to origin; with nothing new since the last `release-N` the step is skipped as "nothing to release since release-N" and the steps after it take that version |
| `publish` | the Mac's publish job for that commit over the peer link (below); a person's decision; skipped "needs a release" without a release before it |
| `deploy` | the box's deploy trigger (docs/box.md "Deploy from the app"): `v1.0.N` when a publish passed, `master` otherwise; skipped "needs a release" when no release step comes before it (a skipped release step counts) |
| `shell` | `run` through the login shell in `cwd` (default the project checkout), detached in its own process group, stdout and stderr line by line into the step's log; exit 0 passes, anything else fails with "exit N after 3s · <last line>" |

`when` is `all-done` (the default: the end of the batch) or
`each-landing`, for a shell step that runs again after every landing (a
deploy to a dev server): the runs are serialized per master, hold the
engine's gating so the end waits for them, keep the step's last outcome
at the end instead of running it again, and a red one tells the master
without blocking the end. `stepsProblem` refuses a repeated or bad id,
two steps of one built-in kind, a shell step without `run`, `run` on any
other kind. Why a list and not more booleans: the five fixed steps were
this app's release train; a Minecraft plugin's batch wants build, deploy
to the dev server, smoke test, and only the master knows which. The
built-in kinds keep their behaviour and their progress labels; a shell
step is the escape hatch, on the same queue with the same telemetry.

The master writes the list with the `batch_rules` app tool (master only,
by the flag at harness boot; codex over the bridge as `app.batchRules`;
with no field it answers the rules as they stand, with fields it sets
those and keeps the rest; `steps` is always the whole list);
`MASTER_MECHANICS` says to write the steps that fit the project when it
opens a batch and to state them to the person in one line. A person sets
them over `batch.setRules { masterId, rules }` (operate, a partial). A new
list keeps the telemetry of every step whose id and kind stay, in the new
order and with the new names (`reconcileSteps`); a row from the
fixed-five days reads its booleans as a list (`legacySteps`). Every change
is the `batch` push.

`Batches` (src/main/server/batch.ts) follows the registry (`attach`: a
child's status change, archive or removal reviews its batch) and runs when
the last child is done: every unarchived root carrying the masterId is
`done`, or `idle` with a turn completed (`Store.hasCompletedTurn`: a thread
between its first user row and its first turn is idle too, and must not
end a batch early). A child that errored or stopped blocks the end, and
so does a child idle on a turn that ended in a failure (its row carries
`failure`: a usage cap, a refused route; `blocked.why` is `failed`): it did
no work, and counting it done once ended a batch with nothing new every
time it retried. `blocked` names the child, the master is told once as a
`<batch-report>`, and nothing runs until it is fixed or archived. Then, on the host's
`GateQueue`: the held merges (all-at-once) under the land step, and the
steps after it in the order written (`runSteps`), the each-landing ones
passed over. A red step stops the rest, the step says why, and the master
is told. **The end runs once per cycle.** It runs at all-done when it has
never run, or when, since it last started, a landing came in
(merge_branch landed a branch, held one under all-at-once, or a far host
reported one), a child joined that was not in the batch then (adopted, or
started into it), or the rules were set (`batch_rules` or `batch.setRules`,
even with the same steps: the hand re-run once something outside the batch
is fixed). Nothing else starts it again: not a child resuming and settling
idle with nothing landed, not a child leaving (archive-children archives
them at the end), not a failed step. A failed publish therefore never cuts
a fresh release on the next idle; one batch once tagged eight empty
releases in a row that way, a child retrying a capped turn every ten
minutes. The row keeps `armed` (a landing, a hold, an adoption or a rules
call since the last start) and `ranChildren` (the children when the end
last started; a row from before the field takes the children it finds as
seen). A landing after any end step ran reopens the steps after land. The gate and the release
row the master with `gate` notice rows as `batch_gate` does; `batch_gate`
stays the master's way to run the gate and release steps early, with
children still out left out of the land step ("4 of 7 landed · 3 left
out"), and is refused when the list names no gate. The steps after land
run whenever the batch ends: they run on the project checkout at the
project branch's head, which does not depend on how the branches got
there (Update 33's children fast-forwarded and pushed the branch
themselves, never calling merge_branch, and the whole end was skipped as
"nothing landed" in 45 ms, nothing for the foot to show). "nothing landed"
is now the land step's detail when no thread had a branch to land; only a
deploy with no release step before it is skipped, as "needs a release".
The land step counts only threads with a branch to land (`canLand`:
implementation and orchestration threads, a chat or research thread once
it landed or holds one, a planning thread never), so "4 of 7 landed" never
counts the planners among the seven. A planning child whose plan is
complete (`planCompletedAt`) and whose build does not exist yet
(`implementationId` unset) is not done: the build starts after the plan
settles, and the batch must not end in that gap. `batch.stopStep { masterId, stepId }` (operate) kills a running
shell step's process group (the step fails as "stopped after 12s") or
stops the Mac's publish job; a gate or release step runs to its end.

Each step carries its telemetry on the wire (`BatchStep`): its spec's
`id`, `name` and `kind`, `status`
pending | running | passed | failed | skipped, `detail` (one line),
`startedAt`, `endedAt`, `progress { done, total, label? }` (land: branches
merged of total; gate: the tier's steps done of total with the running
one as label, read from gate.ts's own `gate: … N steps`, `› step` and
`✓ step` lines; publish: the script's phases done of eight (gate, build,
sign, zip, pack, upload, feed, and the Mac app's own update) with the
running one as label, read from release-publish.sh's `phase › name` and
`phase ✓ name 71s` lines by src/shared/releasePhases.ts; deploy:
box-update's stages seen of seven (source, modules, build, trial,
snapshot, commit, prune) from its `SOURCE:` / `TRIAL PASS:` lines) and
`log` (the console lines as they arrive, the newest 200 kept; the publish
and deploy logs end with one line naming the version and the time, the
publish one with every phase's time in brackets; a shell step's opens
with `$ <run>` and ends with `== <name> passed in 3s`).
The `batch` push is coalesced to at most four a second while a log
streams (the first change goes out at once, the rest trail), and the row
is persisted with each push, so a restart keeps the log. The board's foot
draws a live console per running step with an elapsed timer from exactly
these fields; `batch.get` answers the same shape.

**The release on the box.** `release.ts --push` (only the engine passes
it; the post-commit train never does) pushes the branch and the new
`release-N` tag to origin after tagging, so the Mac can publish the
commit. With nothing new since the newest `release-N` (HEAD is that
commit, or only release bookkeeping follows it: scripts/releaseCheck.ts)
release.ts prints "nothing to release since release-N (package.json
1.0.N)" and exits 0 with no bump, commit or tag (`--push` still pushes the
branch and that tag); the step is `skipped` with those words, no gate row
says it passed, the done line carries it, and a publish after it takes the
existing `1.0.N` (`releaseOutcome`). `batch_gate` answers the same words. Its gate runs through gate.ts, whose Mac-only steps are skipped
off macOS as above.

**The publish, from the box, on the Mac** (remote/peerPublish.ts on the
box, remote/macPublish.ts on the Mac, src/shared/contract-publish.ts;
docs/box.md "Publish a box release through the Mac peer"). The Mac adds
the `publish` offer to its peer.register. The box picks the master's
`macBridge.thread` peer when it is online with the offer, else the only
Mac registered with it; none is "no Mac paired", several name the Macs.
One `publish.start` call (90 minutes) carries the box's caller, the
40-character SHA, the branch, the `1.0.N` version and the notes; the Mac
fetches origin, pulls the branch `--ff-only` in its release checkout
(`release.checkout`, the Publisher's login-shell git), refuses a HEAD that
is not that SHA or whose package.json is not that version, and runs the
job exactly as the "Publish Mac release" button does except for the
train: `Publisher.publish(notes, { train: false })` is `bun run
release:publish` alone, since the box already cut release N (running
release.ts again would cut N+1). The Publisher's refusals (dirty tree, not
master, a version the feed already serves, a publish already running)
come back as the step's failure text; the job's log lines stream through
`peer.progress` into the step's `log`; the result is the exit and a
one-line outcome. `batch.stopStep { masterId, stepId }` (operate) on the
publish step sends `publish.stop`, which kills the Publisher's process
group, then cancels the call. A publish in flight when the box restarts is failed with a
pointer to the Mac's publish log. The step's detail ends "v1.0.N published
in 4m43s", and the version is announced (src/main/server/releaseAnnounce.ts):
the box sends `release-available { version }` down every registered Mac's
socket, the Mac's updater fetches it at once (update.ts `selfUpdate`) and
"Restart to update" is there without waiting for the poll. The Mac's own
Publisher already did the same for itself as the script's `update` phase.

**The same engine on the Mac.** When the master thread lives on the Mac,
`publish` is `LocalPublish` (remote/macPublish.ts: the peer handler's
`run` with no link, Stop through the Publisher) and `deploy` is
`PeerDeploy` (remote/peerDeploy.ts): `host.deploy` with the ref over the
Mac's link to the box (exactly one connected link, else the step names
the choices), then `host.log { job: 'deploy' }` for the snapshot and the
box's `host-log` pushes on the link for the rest. The box restarts into
the new build mid-deploy and the link drops; when it comes back `linkUp`
asks for the log again and feeds only the text the step has not seen (the
box's new process re-reads the whole file), and the fresh snapshot's done
status closes the step. A deploy of a v1.0.N announces the version to the
local updater too. A publish step found running at boot whose version this
Mac now runs is passed ("this host restarted into it"): the person clicked
Restart during the batch.

**The deploy, and the restart it causes.** `deploy: 'box'` fires
`host.deploy` with the ref (hostJobs.ts `DeployTrigger`: the ref written to
`/run/temp-code/deploy/request`, the root-owned runner's `log` and `exit`
files followed); its lines stream into the step and its `==` stages into
the progress label. The deploy restarts the box's temp-code service, which
kills the master's harness and this engine mid-step, so the row
(`batch:<masterId>`, with `deployRef`) is persisted and pushed before the
trigger fires, and after the BootResumer `Batches.resumeAfterBoot` reads
the trigger's status: a `done` with its exit closes the step, runs the
steps after it (a smoke test the master wrote) and `then`, a `running` is
followed on, no files (the deploy did not run) fail it. A shell step
running at the restart is failed as "the host restarted during the step"
and the master told. The master itself comes back through the boot ledger
(below).

## The master stays live, and the person reaches it

A master whose batch is open never idles. `Batches.open(masterId)` is true
while children exist and not all are done, or the engine is at work, or a
step is running; `SessionRegistry.append` turns such a master's `idle`
into `watching` before the row is persisted (`masterKeepsWatching`): the
harness stays up, the batch's settles and `<batch-report>`s wake it as
ordinary turns, the queue and the completed-turn pass drain on that
watching as they do on idle, and the boot ledger (`resume_after_boot`)
keeps the row so a restart brings the master back (into a turn with the
restart nudge, then watching again). The batch closing idles it: the next
turn end is a real idle, and a batch that closes with nothing coming (its
children deleted) idles the master through `registry.masterIdle` from
the engine's review. The liveness sweep only ever flips `running` and
`starting` rows, so a watching master is never "stopped".

A person's message reaches a live master at once. To a watching master it
starts a turn (the idle path in `send`). To a master mid-turn, `queueAdd`
(what the composer calls for a running thread) does not queue: the user
row is kept on the transcript and the text is whispered into the live
turn as `<user-steer>…</user-steer>` (`steerMaster`, the notes-reminder
path; a message with attachments still queues), and a master's
`wait_for_agent` in flight returns `{ status: 'steered', message }` in
every mode (`registry.nextSteer`, raced against the settles), so a
blocking wait never swallows the person; the agents keep running and the
master waits again after acting. `MASTER_MECHANICS` tells the master to
prefer ending its turn and being woken over blocking waits.

Pause and Resume cascade: `session.pause` on a master pauses every root of
its batch on this host (sessionBatch.ts `batchChildIds`, four at a time
through `runSessionBatch`, each child's tree as a pause of that child),
`session.resume` resumes them, Stop stays per thread, and a pause of a
child alone touches neither its master nor its siblings. The paused
banner (chrome/ThreadBanners.tsx `bannerThreads`) folds a batch thread
paused with its master under the master's line: "Master is paused, and 3
batch threads with it, and 2 Mac jobs with it".

## The view

docs/LAYOUT.md "Master" has the diagram and the rules; the board, its
rows, the foot and the add sheet are the UI thread's
(surfaces/threads/master/**). The choices, from the mock:

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
- **Queued as a visible state.** The row exists, dimmed, with the sibling
  it waits for, and the master never has to retry.
- **The batch's own work under the list.** The steps the master wrote,
  with a live console per running step, not a panel, because they are the
  batch's state and not a child's. They stay put while the list scrolls.
- **One sheet for a child's identity.** Type, model, effort, context, host
  and an optional sibling to wait for. The same shape serves the button
  and the master's own tool call.
- **Every host on one board.** The rows are the batch's children on every
  host the renderer knows, a child on the box beside one at home; a row
  away from the master's host carries that host's dot and name where the
  thread header's host chip would, and sits under the offline tint while
  that host is out of reach. Every action, the menus and the archive go to
  the row's own host; the add sheet starts a child on any linked host.
- **Left out on purpose.** No cost column, no provider logos, no per-row
  progress bars, no badges on the title. The type reads as one muted word
  after the title.

Files: surfaces/threads/MasterView.tsx (routed when the session is a
master, whatever its type), master/useMasterModel.ts (the
grouping, the sentence, `useBatchState`: `batch.get` on mount, every 5 s
while the pane shows, and the push through `batchFromPush`),
master/MasterRow.tsx, master/BatchFoot.tsx, master/steps.ts,
master/AddThreadDialog.tsx, lib/masterThread.ts (`isMasterThread`, the
renderer's read of the flag on the thread).

## The wire

- Sessions: `is_master`, `master_id`, `after_id`; `SessionMeta.isMaster`,
  `.masterId`, `.after`; the `queued` status in `SessionStatusSchema`.
  Projects: `master_thread_id` stays in the table, read once and never
  written; `ProjectMeta.masterThreadId` left the wire (gen:swift ran).
- `session.create { masterId?, after?, queue?, startedBy? }` (operate),
  `session.start { sessionId }` (operate), `session.setMaster { sessionId,
  master }` (admin), `batch.get` and `batch.children` (read),
  `batch.setRules { masterId, rules }`, `batch.stopStep { masterId,
  stepId }`, `batch.adopt { masterId, sessionIds }` and `batch.archive
  { masterId, which, removeResources? }` (operate)
  (src/shared/contract-batch.ts: `BatchRulesSchema` with `steps:
  BatchStepSpec[]`, `BatchStep` with its spec's id, name and kind and its
  telemetry, `BatchState` with `rules`, `steps`, `held`, `blocked`,
  `finishedAt`, `BatchAdoptResult`), `app.batchGate`, `app.batchRules` and
  `app.adoptThread` (local, the codex bridge), the cross-host
  `thread.start` args' `masterId`, `thread.pause`, `thread.resume`,
  `thread.archive`, `thread.adopt` and the `crossHost.landing` report
  (src/shared/contract-crosshost.ts; `BatchState.children` and
  `blocked.why: 'unreachable'` in contract-batch.ts), the peer methods
  `publish.start` / `publish.stop` under the `publish` offer
  (src/shared/contract-publish.ts).
- Pushes: `batch` (every client, coalesced), the ordinary `session` meta
  on a pin change and with its `activity` line for a queued row.
- The Swift contract carries `queued`, `GateNotice`, the `batch` push and
  the batch types (`BatchState` with its `Children`, `BatchStep`,
  `BatchStepSpec`, `BatchRules`, `BatchLand`, `BatchThen`,
  `BatchAdoptResult`, `SessionBatchResult`), and the methods `batch.get`,
  `batch.setRules`, `batch.stopStep`, `batch.adopt`, `batch.archive`,
  `session.setMaster` and `session.batch`. The phone's master opens on its
  Board (docs/IOS-DESIGN.md "Master: the batch is the hero"): the rows in
  four groups, the foot with the steps and the running step's console, the
  bar's + Thread and fleet switches, the Rules, add, adopt and archive
  sheets, and the pin for an admin key. The client lands the push at most
  twice a second and asks `batch.get` every 5 s while the board shows. On
  Home a queued root is not under Running (`HomeModel.isLive` counts running
  and starting only).

## Proofs and tests

- `bun run script:e2e-master-batch` (scripts/e2e-master-batch.ts) is the
  whole flow in one process: a scratch repo with a bare origin, every gate
  step stubbed, haiku threads against the real provider. A chat thread
  pinned with `session.setMaster` (a second master of the same project
  beside it, with an empty batch of its own) writes its steps with
  `batch_rules` (land, gate, release and a shell smoke test) and starts
  four children of three types with its own `app_start_thread` calls (one
  `after`); three start at once and the `after` child queues with its
  line; a thread created with a child as `startedBy` inherits the
  masterId; `batch.adopt` takes a loose thread and refuses the second
  master; `list_agents` marks the rows `thread`; the master is watching,
  not idle, while the batch is open; settles wake the master, the waiting
  child is answered through `answer_agent`, the plan child reports once,
  the `after` child starts only once its sibling is idle after a turn;
  child a lands through `merge_branch` held then merged; a chat that is
  not the master starts a Fable THREAD and is refused a Fable SUBAGENT
  while the master's `spawn_agent` is not; with every child done the
  engine runs the steps on its own, the shell step last in the project
  checkout with its lines in the log, rows "Batch done" on the master,
  wakes it with a `<batch-report>` and the master idles; then `batch_gate`
  answers the tag and `batch.get` shows every step passed; `batch.archive
  done` archives the four children and leaves both masters. ALL PASS on
  the box on 2026-10-22.
- `bun run script:e2e-queue`: six haiku threads start at once (no cap),
  `after` holds and releases.
- `bun run script:e2e-batch-gate`: a pinned master, two haiku children,
  one typecheck stubbed red then green, then `batch_gate`.
- Unit tests: rules.test.ts (the tri-state, the master flag),
  orchestration.test.ts (the table by role, supervision, settle reports to
  the master and the starter, `settleTargets`, `batchMembershipOf`, the
  refusal wording), apptools.test.ts (no policy for threads, the catalog
  refusals, `masterId` and `after` from a master and inherited from a
  batch thread), remote/crossHostThreads.test.ts (`startedBy` and
  `masterId` over `thread.start`), db-master.test.ts (the flag's
  round trip, the one-time copy of the project pin), scheduler.test.ts
  (`after` alone), batch.test.ts (the steps list and its refusals, the
  legacy row, a new list keeping telemetry, shell steps passing, failing,
  stopped, each-landing and at a restart, adopt, archive, the blocked
  case, the all-at-once merge and its refusal, the telemetry, the push
  throttle, the deploy's restart, the publish's restart, `batch_gate`),
  contract-batch.test.ts, sessions-master.test.ts (the watching master,
  the steer and `wait_for_agent` on it, the pause cascade, the batch
  following the starter, `setMaster`, archive), sessionBatch.test.ts,
  planFlow.test.ts (the build's inheritance), remote/macPublish.test.ts, remote/peerPublish.test.ts,
  contract-publish.test.ts, hostJobs.test.ts (`train: false`), gate.test.ts
  (the Mac-only skips), gateRun.test.ts (`--push`), threadBatch.test.ts,
  gateQueue.test.ts, mergeReview.test.ts, projectPreamble.test.ts; the
  renderer's useMasterModel.test.ts, MasterView.dom.test.tsx,
  GateCard.dom.test.tsx, TabIndicator.dom.test.tsx, ThreadBanners.test.ts,
  WorkingStrip tests, ThreadHeader.test.ts and
  WorkspaceSessions.dom.test.tsx.

None of the proofs that boot harnesses are in the release gate.

## Not yet

- A far batch child is counted, paused, archived, adopted and landed from
  the master's host; a thread that child starts on ITS host (a far plan's
  build) joins the batch there and is not seen by the master's engine.
- A far child's "done" is its host's `done` or `idle`; the engine cannot
  read a completed turn over the link.
- A thread outside any batch passing `after` to `app_start_thread` has it
  dropped; the tool description says it is for a master.
- `batch.stopStep` stops a shell step and the publish; a gate or release
  step runs to its end.
- `each-landing` is for shell steps; a gate on every landing is a shell
  step that runs it.
- A thread pinned long after its harness booted gets the batch tools and
  the edit denial at its next spawn.
- The publish step's progress counts the script's phases and the deploy
  step's box-update's stages; a line neither script prints as such adds
  nothing to the count.
