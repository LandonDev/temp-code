# Background work and watching: a structured wait on the session row

- The claude driver keeps every live background task as an item
  (`BackgroundTaskSchema` in src/shared/events.ts: id, the model's label,
  `kind` shell | monitor | agent | workflow | cron | other from
  `kindOf(task_type | type)`, `startedAt`, the Stop hook's `command`, the
  starting call's `callId`; a session cron is `cron:<id>`) and emits
  `background-tasks { tasks, items }` whenever the items move (`tasks`, the
  labels alone, stays for old rows, the phone and the MCP facade). The
  registry folds it into `SessionMeta.background` (transient, like
  `activity`): `tasks`, `agents` (live subagent ids), `batch { out, total }`
  for a pinned master's local children, and `watchingSince` (set when a
  status moves the row into watching). A child's status change re-pushes its
  non-root parent and its master. The activity line is `watchLine`,
  "Waiting on <watchSubject>": `watchPhrase` names one task alone by its
  label and one subagent alone by its title, and counts anything more ("3
  subagents, a monitor"; the strip, `wait_for_agent` and the settle report
  read the same words; src/shared/watch.ts, with `STALE_WATCH_MS`
  30 min and `isStaleWatch`), "Waiting on the batch's steps" for a master
  with nothing out. A running turn a `wait_for_agent` holds (the meta's
  `awaiting`) says its agents by title in its activity and `statusDetail`,
  "Waiting on Review the payment flow" or "Waiting on 2 subagents"
  (`waitLine`, `statusWordsOf`; an id `env_…:<sid>` reads by its bare
  `<sid>`), and a parent below the root re-words when its child's title
  lands.
- A wait is a state of the turn, never a transcript row
  (surfaces/agentSteps.ts): while open, `isHiddenTool` hides it and the
  working line says `waitLine` (its `wait` phase, fed by TurnEnd when
  nothing after the wait speaks or runs: `openWaitOf`); once it returns, each agent
  it returned on (`waitOutcomes`: done, idle, watching, waiting, failed,
  error, stopped, paused) folds into the run as an `AgentStepRow`,
  "Finished <title>" (Failed, Needs you, Stopped, Paused by state), the
  same step a report draws; a steered, aborted, timed-out or refused wait
  leaves nothing. A batch spawn draws one `SpawnChildRow` per stamped
  child. Every agent row names its agent by `agentTitle`
  (lib/agentTitle.ts).
- `session.stopTask { sessionId, taskId }` (operate) stops one task through
  the SDK's `query.stopTask` (`DriverHandle.stopTask`); `session.taskLog
  { sessionId, taskId, from? }` (read) answers `TaskLog` from
  src/main/server/taskLog.ts: the task's output file (portSweep's
  `fileOfCall`, else `fileOfTask`), tailed by portLog.ts `readTail`, else
  the call's output in the transcript, else `none`. Neither is in the
  phone's subset. The desktop transcript folds a `background-task` settle
  into the run it woke as one step (`Block.task` in fold.ts, "Task finished
  <label>" through `TaskStepRow`), never a row of its own, beside the
  subagent reports, spawns and host notices that fold the same way
  (`isFoldedStep`, docs/TRANSCRIPT.md "Thinking, closing lines and
  notices"); the event also feeds the digest and the phone.
- A root idle or done whose `background.agents` is non-empty reads
  Watching "a subagent" / "N subagents" wherever `threadStatus` or the
  rail's `rowState` decides (`settledWithAgents`, lib/threadStripModel.ts),
  and the fleet header counts watching on its own ("1 watching, 1 done").
- The title bar's agents cue (chrome/AgentsCue.tsx, left of ⋯): while any
  subagent of the thread on screen (the one its pane shows,
  `useShownThreadId`: a master's open child) works, watches, waits or is queued (by
  `parentId`, any depth; a master's batch is its board's), a quiet 24px
  control (`ROW_CONTROL`): the loudest state's glyph, one 12px provider mark
  per distinct provider of the live agents (`HarnessIcon`, a Meta model's
  maker's mark; one drawing once, `markDrawing`; at most four, then "+N"), and "3 agents", or "1 needs you"
  in amber while one waits; its line "Agents: 1 needs you, 2 working on
  Claude Code and Codex"; working is the still dot while the thread's own
  turn runs; a new count morphs (`MorphText`); a click opens
  or closes the right panel on Agents, pressed whenever the open panel
  draws Agents, by name or as its default (RightPanel reports the section
  it draws, `useShownSection` in lib/rightPanel.ts; `useAgentsCue` in
  lib/threads/agents.ts, woken only for a change in that thread's tree).
  The Agents rows end with a model line: logo, model, effort and context
  window (`ModelLine`, surfaces/threads/ModelMark.tsx).
- Renderer: `lib/activity.ts` joins the meta's `background`, the thread's
  dev servers (its tree's ledger rows and the runs the pane started for it,
  `threadServers`) and its running Mac calls into
  `activityRows` (a master's batch as one row, then oldest first; never a
  row for subagents, which the Agents section lists; a background shell that opened a listed dev server is
  that server's row, matched by call id, else by command; `rowStale`, `hasActivity`, `stopActivity`, `stopAll` =
  `session.killBackground`). `surfaces/threads/ActivitySection.tsx` is the
  right panel's Activity section: 28px rows (glyph, label, the age, Stop;
  a failed Stop toasts), a shell row folding open onto its command and its
  `session.taskLog` output (a monitor writes no file
  the host can read, so it opens nothing; a failed read says so), a dev
  server row the dev servers pane. The slot above the composer (`WorkingStrip`, its rule
  `composerSlotOf` in lib/threadStripModel.ts) holds only the open turn's
  elapsed time and Stop while it works or waits, and the held rows (paused
  with Stop and Continue, stopped with Resume, queued with Start now); a
  watching thread leaves it empty and the transcript's closing line under
  the last settled turn says "Watching" with the stretch's age, amber past
  `STALE_WATCH_MS`, and opens Agents when it waits on subagents, else
  Activity (`watchSection` in lib/rightPanel.ts; `WatchingLine` in
  surfaces/transcript/TurnEnd.tsx, `onOpenActivity` through AgentTranscript).
  The thread on screen is left out of the paused banner (every thread has
  the slot, an orchestration parent's too, and no transcript draws the live
  turn under it) and out of the
  recovery banner for its own failure (its FailureCard has Continue; a
  failed descendant keeps the line). A watch is
  stale (`isStaleWatch`: the amber age, the banner) only past
  `STALE_WATCH_MS` on the thread's own tasks alone: live subagents and a
  master's batch have their own liveness, and Stop all
  (`session.killBackground`) ends only the thread's own background work;
  `chrome/ThreadBanners.tsx` `staleWatchers` adds one banner for the other
  roots of the project watching stale.
