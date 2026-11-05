# The desktop transcript: performance

The transcript (`src/renderer/src/surfaces/AgentTranscript.tsx`) is the
one surface that grows without bound: a chat packs 2,000 rows into 500
turns, an agent thread tens of thousands into two. This page fixes how it
stays cheap, how that is measured, and the numbers it must keep. It mirrors
the phone's rules in docs/IOS-DESIGN.md "Performance".

The window and `RowView` live in AgentTranscript.tsx; every row component
lives under `surfaces/transcript/`, one file per area with its owner named
in the first line: TranscriptBlock (the per-block switch), UserMessage,
ActionGroup (A7, turn structure); ActivityRow, ToolCall, ActionRow,
ActionLine, CommandCard, ToolGlyph and actionModel (A8, action rows);
ThinkingRow with thinking.ts, TurnEnd, SystemRow, NoticeRow (every typed
notice through one switch), NoticeLine, PlanHandoffRow, ApprovalCard,
IconAction and markdown.css (A9).
`transcript/types.ts` holds the callback types, so nothing under
`transcript/` imports AgentTranscript.tsx.

## Action rows

One action (an edit, a command, a read, a search, a fetch, a skill, a call
into the app, a connector call, a subagent spawn, an approval, a todo
update) is one line at 13 px, `[glyph]  Verb  object  +46 −3  extras  ▸`
(`transcript/ActionLine.tsx`). What each row says and opens is decided once
in `transcript/actionModel.ts` (`actionOf`, unit-tested) from the words of
`lib/toolPhrase.ts` (`toolPhraseParts`: the verb muted, the object in
foreground, the same words the group line uses); the components only draw it.

- **One grid** (`transcript/stepLine.ts`): every step of a run, a call, a
  thought, a folded host step, is one line of the same slots, each drawn
  only when it has something: the 14px glyph (`GLYPH_SLOT`) 8px from the
  verb, the verb muted, the target in foreground (it truncates first), the
  counts at the text's size, each 4px from the next, then the row's extras
  (an empty extras slot takes no room, `empty:hidden`) and the chevron on a
  row that opens, 8px after the last value. The glyph box is fixed, so verbs
  line up and each target starts where its verb ends, as in Claude's open
  group. A line is 28px at the prose's edge (a lone call) and 32px in an open
  group's table, which says so with `data-table` (`STEP_LINE`'s
  `in-data-[table]:h-8 in-data-[table]:px-3`; a notice, which can wrap,
  takes `STEP_NOTICE`). Hover lifts the verb and the chevron to foreground,
  at once.
- **The words.** A stand-in object toolPhrase.ts says when a call names
  nothing ("a command", "a file", "the project", "a page", "the web", "a
  question") is filler, not a target: it folds into the verb ("Ran a
  command", all muted); a subagent call keeps its words. A connector's call
  reads as the connector doing it, "Cosmic Admin  Build get": the verb is
  the `mcp__<server>__` prefix through `addonTitle`, the target the tool's
  name in sentence case (`sentenceName`), with no tense (the glyph's spinner
  says it is live); the host's `display.app` words, the app's own tools and
  the orchestrator's keep theirs. A host step folded into a run
  (`StepRowContext`, set by ActivityRow) reads the same way: its lead muted
  whatever its tone (a failure is the glyph's to say), its first detail in
  foreground ("Gate failed  port-the-view  at vitest").

- **The glyph** (`transcript/ToolGlyph.tsx`): one 14 px box, the kind's
  icon from the `GLYPH` record, the connector's mark or the subagent's
  provider in its place, and while the call runs, fails (or was denied) or
  asks for approval the `StatusMark` of working, failed or waiting with no
  word (nothing else on the line turns red; working is a dot, since
  the working line under the turn is the one moving mark); a change of face
  (the call settling: dot to icon) swaps in the box through the keyed
  `SwapIcon`, and the verb changes tense in place through `MorphText` (the
  old word leaves, then the new one arrives). The words hug their text, so
  the caret sits right after them, as on the group line. A command whose
  gist would only repeat it ("Ran bun run typecheck") says "Ran a command";
  more than two clauses end "and N more".
- **What it opens.** A read or a list opens its file in the editor at the
  line it started from (Claude's Read `offset` is that line); its caret
  says so, as on every row that does something, and nothing opens in the
  transcript. A command opens its card
  (`transcript/CommandCard.tsx`: the tool's name, `$ ` in line with it and
  the command in mono, tinted by ink alone through `lib/shellTokens.ts`
  (no status colours), twelve lines then Show all, what it printed under
  it, nothing when it printed nothing). What it printed shows whole in a
  box capped at 320px that scrolls inside itself, Copy on hover taking all
  of it (`ToolOutputLines` in ToolDetails.tsx; one text node, so 10,000
  lines cost one render). An edit opens its diff (`EditRow.tsx`,
  `DiffBody.tsx`), on the caret only, never on its own while it streams;
  its counts tick instead. Anything else opens its details
  (`ToolDetails.tsx`: the invocation, key and value rows for JSON, the
  output; the raw view behind a ghost icon button on hover). An app call
  that names a thread links its title to that thread. An agent row names
  its agent by title, never by its prompt (`agentTitle` in
  lib/agentTitle.ts: the store's title, else the spawn's `title`, else a
  report's stamp, else the task's first line until a title lands, else "a
  subagent"; cut at a word past 48 characters, the whole in the tooltip).
  fold.ts stamps each `agent-spawned` child on the `spawn_agent` call that
  asked for it (`tool.spawned`): a spawn of one is that call's row, linked
  to the agent from the moment it exists, with the child's host glyph and
  state (`SpawnedAgentMarks`, Working drawn still); a spawn of several is
  one "Spawned <title>" row per child (`SpawnChildRow`, as an edit is one
  row per file), and "Spawning 3 agents" only until the first child is
  stamped; an older log with no such call keeps a "Spawned" row of its own.
  A todo update says how far the list is as a
  muted tally in the counts slot, not a target ("Updated todos  3/7"), and
  opens the list. The body opens in place under
  the line through `Collapsible`.
- **Approvals.** A call waiting on the person draws its line in the live
  tense with the waiting mark and no caret, its own body open under it (the
  command card, the details, an edit's diff per file) so what it asks is
  read once, and A9's `ApprovalCard` (Allow and Deny) under that; once
  decided the card is its one verdict line and the row an ordinary row
  again. Inside an open group's table it keeps the table's grid: the amber
  mark under the row glyph, 12px in, and the verdict under the row's words,
  34px in. An edit's bookkeeping row leaves the card to its parent
  (`ActionRow approval={false}`), so one call has one card.
- **One frame, never two.** An open group's rows sit in a table, as
  Claude's: under the line, one hairline frame with a 12px radius from the
  prose's edge across the column, no fill, a 32px row per step (our 20px
  line and 6px above and below, a step looser than the prose's 28px) with
  its words 12px in, and a hairline between two rows (ActionGroup's
  `data-table`; the frame is a separate inert span drawn over the rows'
  edges, `overflow-clip` on the table, so the window's glide moves the rows
  inside a frame that stays put). A lone row is bare and lines up with the
  prose. A row's open body standing alone is a card of its own (`BODY_FRAME`
  in ActionRow.tsx: hairline, rounded-lg, bg-card, p-3; an edit's diff in
  the same card with its tints to the edges); in the table it is the row's
  lower part, across its width under one hairline, its content 12px in with
  8px above and below (`TABLE_BODY` in stepLine.ts for a thought's and a
  notice's), so no card sits in the table; a `bg-card` ancestor (the board's
  task card) cancels it. A notice that opens (a red gate's log, a review's
  minor findings) draws that body inside its fold, so a closed one leaves no
  ruled band under its line, and a gate's log in the table is plain mono
  text in the row's body, no card of its own. Opening a body inside
  a group is a hand on the group (`transcript/groupHand.ts`), which decides
  it from then on. Hover lifts the verb and the caret to foreground, as the
  group line does.
- `transcript/ActionRow.fixtures.tsx` holds one of each row for a static
  look and `ActionGroup.fixtures.tsx` a working group at 2, 5 and 9
  rows; `ToolRow.dom.test.tsx`, `EditRow.dom.test.tsx` and
  `ActionGroup.working.dom.test.tsx` prove the behaviour.

## Thinking, closing lines and notices

- **A thought** is no row. While it streams the working line says
  its newest finished sentence in Thinking's place (`latestLine` in
  `transcript/thinking.ts`); once it ends it leaves nothing in the run,
  short or long, and shows only in a group a person opened by hand, as
  "Thought ›" with no duration (`transcript/ThinkingRow.tsx`), opening the
  text on a `Collapsible` whose trigger lies over the row it names. The
  implementation board's running task draws no thoughts either.
- **The working line** (`transcript/WorkingLine.tsx` `TurnLine`, drawn by
  TurnEnd): each live turn ends in one 28px line at the prose edge, from
  Send to the turn's end: `WorkingMark` (three dots that gather and part)
  in the glyph slot, then the phase's words in `WorkingText`'s shimmer,
  morphing through `MorphText` as the phase changes. `workingPhase`
  (`transcript/workingPhase.ts`, first match wins): Sending until the host
  echoes the message; the host's words for the wait while nothing of the
  turn's own has come (keyed up to the first comma, so "25 s" becoming
  "30 s" is drawn in place); an open wait on agents, "Waiting on <title>"
  (UI-15's `openWaitOf`, `waitIds` and `waitLine`); the running calls, one
  by its verb and object ("Reading format.ts"), several by the group's
  present-tense phrase; while a thought streams, its newest sentence in the
  word's place (Thinking until the first), each sentence its own phase
  (`thought:<n>`), so one morphs into the next and a long one ends in an
  ellipsis at the row's edge, said once to a screen reader as Thinking
  (`spoken`); the mark alone while prose streams; else Thinking.
  `useHeldPhase` (lib/heldWord.ts) holds a phase 300 ms by its key, so one
  that lasted 40 ms never paints. A call the line tells (`toldByWorkingLine`
  in transcriptActivity.ts: pending, not waiting on the person, not agent
  work) is no row of its group while the turn is open; it lands there as a
  past-tense row (`.step-land`) once it settles. One running edit shows its
  live counts on the line; one running command or tool shows a chevron and
  opens its body under the line, and a call opened there lands open in its
  group, which counts as the person's hand (`transcript/workingOpen.ts`).
  The line's life cycle: once live in a mount it is one element until the
  pane goes, never keyed and never unmounted. While a step waits on the
  person (its card says so) or the turn is paused it folds closed on
  `.collapsible-auto` with its words as they were, and a resume reopens the
  same element. A Stop morphs it to Stopped the moment the stop row lands
  (the row itself draws nothing, open or settled). When the turn settles in
  front of the person the line is the closing line in the same element: the
  mark leaves as an icon does, the words morph into "Worked for 2m 4s" and
  slide 22px to the prose edge (a FLIP on `--ease-swap`); a turn over before
  its duration lands says "Worked" and the time fills in under the same
  words. The closing waits for the reveal: while any row of a turn the host
  has settled or stopped still reveals its text (every stream step painted
  and its fade done; AgentMarkdown reports `!settled` through
  `useReportReveal`, surfaces/revealDrain.ts, under its row's turn), the
  line keeps its mark and says nothing more, so no closing line is drawn
  above text still appearing. The echo of the person's message renames
  the block but not its row: the claim keeps the optimistic key
  (`Block.rowKey`, `rowKeyOf` in transcriptRows.ts), so the bubble and the
  line stay the same elements and no fade plays again. A call's counts and
  chevron are part of its words, inside the morph, and leave with them.
- **The closing line** (`transcript/TurnEnd.tsx`): "Worked for 2m 4s" and
  four hover-only icon actions (`transcript/IconAction.tsx`: a ghost
  `icon-xs` Button in a Tooltip armed on the line's first hover, so a long
  settled transcript mounts no tooltip roots); a live turn speaks
  `StatusMark`'s words. No clock time.
- **Notices** draw on `transcript/NoticeLine.tsx`: a 14 px glyph slot that
  lines up with the action rows' tool icon, the lead, each detail its own
  muted span and hover actions, at the action rows' 13 px on 20 px in a 28 px row; a line
  that opens is its own trigger with a bare chevron, as a row is. Gate, compaction, pass,
  handoff, plan hand-off, batch, account-gone, a stopped turn and any plain
  system text are lines; a held review (`ReviewCard.tsx`) and a failure
  (`FailureCard.tsx`) are the only cards. A plain notice keeps its kind on
  the block (`Block.notice`, from fold.ts), so `NoticeRow` draws it typed.
- **A compaction** is one row (`surfaces/CompactionCard.tsx`): "Compacting
  context" with its time counted from the compaction's start, never reset;
  its outcome replaces that row in place (the fold's `compactionId`), even
  after a message came in, and a turn that ended without one closes it as
  "Compaction stopped" with its span. While it runs its glyph is working's
  still dot, as is a hand-off's while it is prepared (its words shimmer):
  the working line holds the transcript's one moving mark.
- **The host's steps fold into the run** (`isFoldedStep` in
  `surfaces/transcriptActivity.ts`): a subagent's report and each agent a
  `wait_for_agent` returned on, as one step each (`AgentStepRow`: the
  state's glyph, then "Finished", "Failed", "Needs you", "Stopped" or
  "Paused" and the agent's title; the batch's own report "Finished  the
  batch", linking nowhere), a spawn row from an older log, a background task that settled
  (`Block.task`, drawn by `TaskStepRow`: "Task finished  deploy the
  preview"), the check on idle tasks ("Checked background tasks",
  `Block.backgroundCheck`), a gate or release outcome, a review that merged,
  the turn pass, the plan's build hand-off and a merge the batch made. Each
  is a step of the run it sits in and draws inside the list with the line
  it draws on its own (`ActivityRow`); a gate's log and a review's findings
  open in place there. What stays a row of its own: the person's text, the
  prose, the plan, a question, an approval still undecided, a held review,
  a failure, Stopped, compaction, "Batch done", account-gone, the restart
  line, the handoff divider and an html_render page. A wait is never a row:
  while it is open the working line says "Waiting on <title>" ("Waiting on
  3 subagents"; the `wait` phase of `workingPhase`, which TurnEnd feeds
  `waitLine` over `openWaitOf` in surfaces/agentSteps.ts, re-worded in
  place when the title lands), and a wait that
  returned on nobody (steered, stopped, timed out, refused) leaves nothing.
  The group line counts steps, not calls (one report alone is its own row;
  a wait counts one step per agent it returned on, a batch spawn one per
  child; a red gate, a review that failed to run, a failed report, a failed
  agent a wait returned on, or a failed task add to its red figure) and
  speaks agent work through `appView` (`lib/groupPhrase.ts`): "Spawned
  “Port the view”, heard from “Port the view”", a wait's agents heard from
  with the reports, like steps folding into a count ("heard from 3
  agents", "merged 2 branches"); an agent the store has not listed is named
  by what its spawn in the run called it (`spawnedNames`); a run of mostly
  agent work leads with the Bot glyph (the `agents` work kind).
- **A question** from the model is the one question card
  (`components/ui/question-card.tsx`, keys taken only inside the card)
  through `surfaces/QuestionCard.tsx`: an Other field unless the question
  forbids free text, Skip dismisses the set; once answered, one line per
  question says what was picked. It enters once (a fade and a 4px rise,
  never again when the window remounts its row), Next cross-fades the
  questions in place while the card's height glides, and the answer folds
  the card closed on `.collapsible-auto` as its lines open, at the click:
  an answer the host refuses opens the card again with its picks and a
  toast.
- **Prose and code** (`AgentMarkdown.tsx`, `CodeBlock.tsx`,
  `transcript/markdown.css`): 14/22 prose (`size="compact"` is 14/22 for
  panels) whose blocks set their own rhythm under streamdown's (every gap a
  margin-top, docs/DESIGN.md "The transcript"), one plain inline-code pill
  one pixel under its text, a quiet code block coloured by weight on
  `lib/transcriptCodeTheme.ts`, whose colours are the ink tokens, with its
  28 px header only when the fence names a file or a language.

## Rules

- **Rows are the unit.** The thread is a flat list of rows
  (`surfaces/transcriptRows.ts`): one per turn item (a block, or a group:
  every step between two paragraphs, todo updates and the host's folded
  steps included (a thought is drawn only in a group opened by hand, and a
  call still running only once its turn is over), one muted line whose rows sit in a table under it
  when it opens; a group of one step is that step's own row, the same tree,
  so a second call landing remounts nothing; the group the open turn works
  in, `working`, opens on its own at two calls, shows its newest five rows
  and folds `FOLD_HOLD_MS` after the work moves on), one closing row per turn (its
  duration line, the live timer, the working line), and a `more` row at
  the top for the remote profile's "Load earlier messages". A row is keyed
  by the id of its first block, so it keeps its identity as the window
  moves, as the live turn grows into it, and across a rebuild with older
  turns added above. Rows of a settled turn are cached per turn array
  (`stableTurns` keeps those arrays), so a streamed delta rebuilds the live
  turn's rows alone, and `RowView` compares a row by what it draws
  (`sameRow`: an item row's blocks by identity, its gap, live and working,
  its turn's id, index and whether it is the last; the closing row its whole
  turn), so of those it re-renders the row the delta changed and the
  closing row.
- **The gap belongs to the boundary.** Each row carries the space above it
  (`ROW_GAP` in transcriptRows.ts: 16px before the first row, 32px between
  turns, 16px under a bubble, 12px between blocks or a block and a line,
  4px between two lines, 8px to the closing line and under "Load earlier
  messages"), applied by `RowView` as `has-[>*]:pt-*`, so a row that draws
  nothing (an empty closing row, a null notice) stays 0px tall; no row has
  margins of its own, and the column ends 16px under its last row
  (`pb-4` outside the measured container).
- **Estimates follow the metrics.** `estimateRowHeight` is the row's gap
  plus its body: 28px a line (a closed group, an action, a thought, a
  notice, the closing line), a working group 28px plus 32px (`TABLE_ROW`)
  for each of its newest five rows and 1px for each rule between two, prose 22px a line at about 100 characters plus 40px a
  fence, a bubble 16px plus 22px a line, a failure card 88px, a closing row
  that draws nothing 0.
- **Only the viewport is mounted.** `lib/transcriptWindow.ts` (`RowLayout`)
  holds every row's height, estimated until measured, with offsets as
  prefix sums. The transcript mounts the rows that meet the viewport plus
  one screen of overscan each way (at least 400 px), each absolutely placed
  at its offset inside a container the height of the whole thread. The
  mounted range re-renders only when the viewport comes within half a
  screen of its edge, or it reaches two screens past it; a scroll inside
  the band renders nothing.
- **Measurement writes the DOM, not React.** One ResizeObserver measures
  every mounted row. A measurement writes the container height and the
  `top` of the rows below it straight to the DOM in the observer's pass
  (React writes the same values when it next renders), and moves the scroll
  offset by the growth of the rows above the reader's anchor row
  (`anchorShift`), so nothing under the eye moves. Rows at or below the
  anchor grow downward, away from the reader. Measured heights are kept by
  key, so a row that comes back is laid out at its true height.
- **The tail touches only itself.** While streaming, the live turn's rows
  are the only ones that render; the growing row changes its own box and
  the container's height. Rows are placed with `top`, not a transform: a
  transform per row is a compositing node per row, and Chromium's layerize
  step then costs about 2 ms on every token. Never put
  `content-visibility` or size containment on a row: the window measures
  natural heights. A tool output's box caps itself with `max-height` only,
  so an open row's height is that cap and the window reads it as measured.
- **Anchoring.** The scroll engine's modes are unchanged (`follow` rides
  the bottom on a spring, `parked` holds the prompt at the top over the
  runway, `free` leaves the reader alone; only the wheel, a scrollbar drag
  and keys release a mode). The reader's anchor row is read on every
  reader scroll and every engine write; rows landing above (a page of
  history, a turn regrouping) put it back where it was unless the
  transcript is glued to its end. Scroll memory across a remount is the
  anchor row and the offset into it (`TranscriptScrollMemory.anchor`), so
  the place survives heights being estimates again.
- **Jumps go through the window.** The message list and a search hit name a
  block id; `scrollToRow` glides to a mounted row's box, or teleports to
  within 2.5 screens of an unmounted row's estimated offset, glides the
  rest, and lands exactly once the row is mounted and measured
  (`landing`). A keyboard jump from the message list (Enter or Space,
  `scrollToRow(index, { instant: true })`) writes the offset at once and
  lands the same way: a key is never animated. Folding the list
  (its chevron, ⌘⇧M) touches no row, offset or column: the list is a
  zero-height sticky child, and beside it the column keeps its place. The parked prompt of an own
  send waits for its row to mount (`pendingPark`), then the runway is laid
  and the transcript glides there (`DUR.drawer` on `EASE_DRAWER`; in one
  write under reduced motion); a prompt whose row is not mounted (the
  reader far up) glides toward its layout offset at once, within 2.5
  screens like any jump, so the window mounts the row on the way: while that glide runs, `layoutRunway` moves
  its target from the row layout and never writes the offset itself, and a
  row measured above moves a glide in flight with the content. Jumps and a
  burst while following glide on `DUR.drawer` `EASE_OUT`, the runway
  retires on `DUR.base`, all read through `cubicBezier` (lib/ease.ts).
- **The follow loop rests when it has settled.** The scroll engine's
  frame loop (`tick`) runs while a glide, the runway's retreat or the
  follow spring has somewhere to go, and stops once all three have
  settled, running thread or not. New rows, the content growing (the
  content ResizeObserver), a viewport resize and the reader's wheel or keys
  start it again. Before 2026-11-02 it asked for a frame for as long as the
  thread ran: one busy transcript on screen read `clientHeight` and
  `scrollHeight` every frame through a silent tool wait (465 ms a minute
  and 3,614 style recalcs a minute on the box, against 929 on an idle
  board). Test: AgentTranscript.window.test.tsx "AgentTranscript follow
  loop".
- **The stream reveals a phrase at a time and costs nothing per frame.**
  `useSmoothText` (surfaces/smoothText.ts) is an adaptive jitter buffer,
  the way a media player plays packets that arrive unevenly. Measured
  2026-11-05 (a box thread, ~700 words of prose): on the box itself the
  host's deltas come every ~20 ms; over the tunnel the Mac saw gaps of
  p90 99 ms and p99 120 ms, frames of up to 104 rows (1,632 chars) at once,
  and once a whole 3,342-char reply inside 4 ms, the final row 0 to 37 ms
  after the last delta. The rules:
  - **The base pace** is the arrival rate: the text that arrived over the
    last 1.5 s of the rate's clock divided by the time it took, a gap
    counting `PAUSE_MS` (1 s) at most, so frames a link releases together
    count whole and a pause only dims the rate; a burst counts at
    `BASE_MAX_CPS` over a step at most. It is clamped to 25–1,500 chars/s
    (`DEFAULT_CPS`, 400, before the first gap).
  - **The lead** is held behind the live end, as text at the base pace left
    once a step has shown its share. It is seeded by the thread's host
    (`useRevealLead` in transcriptSession.ts: `LEAD_LOCAL_MS` 100 ms on this
    machine, `LEAD_REMOTE_MS` 250 ms for another host), never under twice
    the gaps' 90th percentile (100–800 ms). An underrun (the shown text
    reached the live end while live and waited) grows it to 1.5 times, or
    by the wait if more, up to 800 ms; with no underrun its excess decays
    toward that floor with a 6 s time constant.
  - **A spurt holds** (the first chunk, and the chunk that ends an
    underrun) until a lead and a step of text are in hand, or as long has
    passed: it waits once for enough to stream smoothly.
  - **Then it never runs slower than the stream** while text is in hand,
    leaning faster (at most 1.5 times) while more than the lead is
    buffered, and **every character shows within `CATCH_UP_MS` (1.5 s) of
    arriving**: the catch-up's pace is each arrival's backlog over the time
    it has left. That replaces the old 900-char skip, so a burst or a whole
    reply plays out over steps (a 3,342-char reply over 15) instead of
    landing in one.
  - **The stream's end drains**: the final row no longer snaps what was in
    hand; it reveals at the same pace with no hold, and the last step shows
    the whole text. Only a rewrite and a hidden pane snap.
  - **A row born live reveals from its first word.** AgentTranscript keeps
    the row keys it opened with; a row that joins the last turn after that
    and was never shown is born live (`RowBornContext`), and its assistant
    prose passes `revealFromStart`, so a row whose first commit already
    carried most of the reply, or the whole of it settled, still reveals.
    History, a page loaded above and a row scrolled back into view show
    whole.

  It steps every `REVEAL.stepMs` (100 ms), waiting on a timer between
  steps, so a step carries what 100 ms of the stream holds (about 35 to 45
  characters, Claude's group size) and the markdown re-parses ten times a
  second, not thirty. `revealCut` ends each step at a word boundary (a
  token over 24 characters with none is cut where the pace reaches), and
  while it reveals it holds a bare block marker (`#`, `-`, `1.`, `- [ ]`)
  and a table's header row until they have content, so an empty heading or
  raw pipes never paint. Each step fades in as one span:
  `lib/streamReveal.ts` is a rehype plugin on the streaming path, one per
  row (named per row, since streamdown caches processors by plugin name),
  keeping a ledger per block of the steps it has seen; every step's text is
  its own span so it keeps its element, and only a step under 400 ms old
  carries `.stream-step`, a CSS opacity animation over `--dur-reveal`,
  linear, that the compositor runs. Nothing reads layout per step and
  nothing animates per frame in JavaScript. The settle waits for the drain
  and the last step's fade (a Stop's too) before the cached tree replaces
  the streaming one, and reaches streamdown through `isAnimating`, since
  its memo ignores the plugin lists. Tests: smoothText.test.ts (the
  measured cadences on test/revealSim.ts, which steps the pacer as the hook
  does), smoothText.dom.test.tsx, lib/streamReveal.test.ts,
  AgentMarkdown.reveal.test.tsx, AgentTranscript.born.dom.test.tsx; the
  soak's `--burst` and `--reveal-report` (docs/box.md "A bursty stream").
- **A streaming code block is coloured, a line at a time.** CodeBlock asks
  the shiki worker at once and then at most every 150 ms
  (`HIGHLIGHT_EVERY_MS`, never put off by a delta). It draws one
  `<span class="line">` per line, each line's markup swapped inside its own
  element (`splitColoured` takes shiki's answer apart: the `pre`'s class,
  style and tab stop, each line's inner HTML; a real `highlight()` answer
  pins it), and until the newest answer lands it draws the coloured lines
  that still read the same and the lines past them plain under the same
  `pre` (`colourLines`), so a recolour never replaces a line, a new line
  never waits and colour never leaves. Inside an open fence `revealCut`
  holds the cut to the start of the unfinished line, so a code line shows
  once its newline arrives; a line held `REVEAL.lineHoldMs` (600 ms) steps
  by words, so every character still shows within the 1.5 s promise. While
  the row streams, AgentMarkdown hands its reveal to the code blocks in it
  (`StreamRevealContext`, null once settled): `lineTimes` keeps a ledger
  per fence, keyed by the code's first 32 characters, of when each line
  first showed, a line younger than `REVEAL.fadeMs` carries `.stream-step`
  (a new line counts as a step, so the settle waits for its fade), and the
  body glides to its new height on `--dur-base` (`useHeightGlide`, its
  vertical overflow hidden so the glide cuts). Tests:
  CodeBlock.stream.dom.test.tsx, lib/streamReveal.test.ts.
- **Blocks born mid-stream rise.** After the steps are wrapped,
  lib/streamReveal.ts walks the block once more: a list item, a table row,
  a heading or a direct child of a quote whose first prose character is in
  a step still fading takes `.stream-rise` (the phrase fade on the element
  plus a 4px rise over `--dur-base` `--ease-out`), and that step's spans
  inside it drop their own fade; a later step growing it fades as before.
  One element per branch rises, a paragraph outside a quote never does, a
  fence rises through CodeBlock when its first line is young, and a
  table's card fades in with its header row (the table wrapper's
  `:has(thead tr.stream-rise)` rule). The ledger keys a block by its first
  32 characters and hast keys children by position, so an item keeps its
  element and never rises again when the list grows or nests.
- **The open tool table glides.** When rows land in an open group's table
  its height glides on the layout spring from where it is drawn to the
  rows it now shows (`useHeightGlide` in lib/heightGlide.ts, keyed by the
  shown rows' ids, read after the window's pull-up, so one in and one out
  at the cap nets nothing), retargeted from the screen when another lands
  mid-glide; a fold, the lone-to-table entry and a hand's decision glide
  nothing, having motion of their own. Rows landing in one commit wait
  their place in the batch, `--stagger-step` (30 ms) apart, the fourth and
  later at three steps; `@starting-style` holds them unseen meanwhile.
- **Markdown parses off the main thread.** A settled markdown row asks
  `lib/markdownParse.ts` for its tree; `lib/markdown.worker.ts` runs
  streamdown's own block split and remark → rehype chain (shared through
  `lib/markdownPipeline.ts`, so the markup is byte for byte what a
  main-thread parse gives) and answers one hast per block. The answer
  fills the hast cache under each block's text, which is the key
  streamdown's pipeline reads back through `restoreHast`, and the row
  mounts the cached tree with no parse on this thread. Until the answer
  the row holds its place with the text, unseen, in the same measure;
  nothing fades, since a row scrolling in is not an event. Requests are
  shared by row digest; the worker keeps its answers by digest too. The
  texts one commit asks for go to the worker together, the last asked
  first: rows ask top to bottom and a thread opens at its bottom, so the
  rows on screen parse before the screen of overscan above them.
  Streaming rows keep the incremental main-thread path, parsing the last
  block only. With no `Worker` (tests, node), or a worker that fails to
  load, throws, or gives no first answer within 8 s, every text is ready at
  once and the main thread parses as before: a row never waits on a worker
  that is not coming (`parseWorkerStats.failures` counts it). Once the
  worker has answered, a request past 1.5 s parses that row alone on the
  main thread while the worker keeps serving the rest, a row that unmounts
  cancels its request (dropped before posting, else a `{ cancel }` the
  worker's queue honours before parsing), and the ready set is a
  4,000-digest LRU tied to the hast cache, so an evicted tree is asked for
  again. The worker
  bundles micromark, whose entity decoder picks a DOM build under the
  browser condition; electron.vite.config.ts aliases
  `decode-named-character-reference` to its plain build for the whole
  renderer, since a worker has no document.
- **Nothing animates on scroll.** A row born after the transcript opened
  fades in once, on its first mount; one that leaves the window and comes
  back is history. The fade is `--dur-fast` (120 ms) of opacity, off under reduced
  motion. Jumps glide the scroll offset; under reduced motion they land.

## No jerk in any scenario

The transcript stays smooth whatever happens: no element on screen unmounts
and mounts again where its content could change in place; no box changes
height without a fold or a glide on the tokens (`.collapsible-auto`,
`useHeightGlide`), and the reader's anchor absorbs what grows above it; no
two states are drawn at once; nothing animates on the first paint of
settled content; nothing asks for frames it does not paint; no long task
over 200 ms.

- **The scenarios.** A turn from the composer (Sending, the host's words,
  the thought, calls, prose, the group opening at two calls, the closing
  line); a fast turn (every phase that paints holds 300 ms, the closing
  line included: a turn that ends inside the hold waits for it,
  `useHeldWord` on "closed" in TurnLine); a long call, then a burst;
  thinking sentences every 100 ms and every 2 s; a steer, a pause and
  resume, a compaction starting and ending, a Stop; a subagent spawned,
  waited on and finished, then the thread watching; the reader scrolled up
  while it all streams; a resync replaying the rows and the pane remounted;
  reduced motion; a burst that lands whole with the turn ending 30 ms later
  (the closing line waits for the reveal's drain, revealDrain.ts); a
  question card arriving, paged with Next and folded into its answered
  lines, at the bottom and with the reader scrolled up above it (the card
  is the last row, below the reader's anchor, so its height glide moves
  nothing above it and the scroller is never written); ten parallel calls
  landing in the open table, one every 300 ms then four at once; a 40-line
  code fence streaming in; a list of 8 items, then a table of 6 rows.
- **The runner** (src/renderer/src/surfaces/AgentTranscript.scenarios.dom.test.tsx
  on `transcriptScenario.testkit.ts`): each scenario as timed store pushes
  through the whole transcript; after every push, and again once it has
  settled, a row still on screen is the same element and takes no fade it
  did not have, the turn's line once live is the same element, and every
  `MorphText` shows one set of words (`watch`); the fast turn's phases are
  read off the line as it paints them (`phaseLog`). It found that rows
  landing before the tail pushed the last row, the live turn's line, out of
  the window for one commit, which remounted it: the window grows with the
  tail in the same render (AgentTranscript.tsx, `tailLength`). The
  streaming motion's element rules run in the same check (`watchMotion`,
  usable on any container): a tool table's step keeps its element and
  never lands again, a code line keeps its element by its block and index
  and never fades again, no block rises twice, and a tool table or a code
  block's body never changes height by 16 px in a step without a glide
  unless its group's fold changed. The fence and the list and table run
  through AgentMarkdown on the real streamdown pipeline
  (AgentMarkdown.scenarios.test.tsx, since the dom project stubs
  streamdown). They found that a fence's last line stepped 20 px because
  the closing fence made the block complete in the same step (the body now
  glides while its row's reveal is armed, whatever the fence), and that a
  table row being typed with only its pipes drew as an empty row that then
  filled and rose (`revealCut` holds such a row).
- **The recording** (`measure-renderer-soak.ts --scene scenarios`): the
  synthetic host plays the same scenarios as a timeline of the host's own
  events (scripts/lib/soakScenarios.ts) on one chat thread with history
  above it, at real speed, once the window shows it; `--screencast <dir>`
  writes every painted frame as `<ms>.png` with `index.json` (each step's
  time and the frames from it to 600 ms after); `--reduced-motion` and
  `--scrolled-up` are its switches, and `--trace <s>` (in a run of its
  own: ending a trace stops a screencast) reads who asks for each frame.
  A step with `clicks` is the person's hand: the soak clicks the question
  card's buttons over CDP (`questionClicks`), so the recording shows Next.
  The frames showed `MorphText`'s width glide ellipsizing the arriving
  words ("E… +3 −1", "Worked…"): while it glides the new words now keep
  their own width and the box clips them (`data-gliding`, components.css),
  so they unroll left to right. `--height-report` (scripts/lib/heightReport.ts)
  watches every open tool table and code block with a ResizeObserver the
  script installs and fails the run on a jump: a change of 16 px or more in
  one frame with the box still on both sides of it (a glide's frames have
  motion beside them; a box hidden or shown again, to or from 0, is a fold).
  Under `--reduced-motion` it reports and never fails; with `--scrolled-up`
  the reader's top row must hold through turn 6 (each send parks the
  prompt, by design). On the box (2026-11-05): no jump with motion (the
  turn-6 table drawn at 65 heights, the fence at 188), and the top row held
  scrolled up, with motion and without. The gate scenes, base master
  against the branch, interleaved, under another load on the box (load
  average 35 to 60 from other agents' builds, so every run, base included,
  read over the CPU bounds): board 65.5 and 48.5% for base, 53.3 and 53.9%
  for the branch; chat over four rounds 28.7, 26.6, 36.7 and 38.0% for base,
  30.6, 35.1, 38.3 and 38.7% for the branch (means 32.5 and 35.7%); no long
  task over 200 ms, heap and RSS growth inside the gate's rules in every
  run. The entry closure went from 5,134.5 kB to 5,131.0 kB with the review
  chunk paying for the motion.

```bash
bun x electron-vite build   # a hand run reads out/ as it is
bun scripts/measure-renderer-soak.ts --scene scenarios --screencast /tmp/cast --height-report --port 9277
bun scripts/measure-renderer-soak.ts --scene scenarios --screencast /tmp/cast-rm --height-report --reduced-motion --scrolled-up --port 9277
bun scripts/measure-renderer-soak.ts --scene scenarios --trace 20 --port 9277
```

Read the frames inside each step's window, not all of them: `index.json`
names them.

## A restored tab is the store's thread

At boot the layout restores its tabs before any remote socket is open. The
active pane's first load fails then (`startLoad` rejects "not connected");
`loadSession` still answers the store's session (hydrated from the launch
mirror, with its `isMaster`, `status` and the rest) and the pane retries the
load when the socket opens. A layout stub (`newSession`, which sets no
`status`) handed to `sessionStore.mutate` for a thread the host has named
takes the meta's fields instead of replacing the view: later metas patch
only what changed, so a stub that once overwrote a listed master's view
left it without `isMaster` and the pane drew a plain chat with no board
(1.0.299–1.0.301, the Main v2 master after every update).

## Opening a thread on another host

The time from a click to rows on screen for a box thread is round trips,
not bytes: from the Mac a request on the box's socket takes about 200 ms
(130–340 ms), the Mac's download runs at 3.5–5.9 MB/s, and a 300-row tail
of a long agent thread is 874 KiB to 1 MiB before deflate, about 150 KiB
after. The box answers it in 25–40 ms and the renderer folds its 4,000
event rows in 13–17 ms (box CPU).

- **One round trip.** Over a remote link a cold open sends
  `session.events { tail, subscribe: true }` (lib/connection/
  subscriptions.ts): the host puts the socket's listener on before the
  read, so a row appended after it is pushed and one before it is in the
  page, and answers `subscribed: true`. A local socket keeps the two plain
  requests. A host that predates the flag answers without it; the client
  then subscribes and folds the gap since the page's last row. A cold open
  that fails sends `session.unsubscribe`, since the host may have
  subscribed before the answer was lost.
- **The recently shown stay.** The store keeps the last `KEEP_RECENT` (6)
  transcripts whose panes left the mounted set loaded and subscribed
  (tcserver/store.ts `keptLoaded`), on top of the warm tabs; a switch back
  paints from memory with no request, and the rows it missed came as
  pushes. A reconnect replays their gaps with the mounted panes', the same
  bounded set, so nothing acts on a stale copy. Older ones unload as
  before.
- **A fetch belongs to its owner.** `Subscriptions.resume` joins a fetch in
  flight only when it was made for the same handlers; otherwise it waits
  that fetch out and sends its own. A transcript unloaded while a
  reconnect's gap fetch was still out (a slow host after a restart) once
  joined that fetch on its next open: the page went to the handlers that
  had left, nothing folded, and the load still finished `loaded`, so the
  pane showed the new-thread page over a master with 4,194 rows. Now a
  first load that ends with no page for its transcript fails into a retry
  ("no answer yet"), and the pane shows EmptySession only when the host
  answered with no rows (`load.empty`, set at `finishLoad` from the
  cursor); rows that fold to no blocks open the thread's own view. Even
  then only a draft gets EmptySession: a thread its host holds with no
  rows shows the composer under one muted line (`NoRowsLine`), an id the
  host does not show is refused (`unknown session`) and reads `gone`, and
  a provisional entry (a tab opened or restored before its meta came) is
  settled by its host's archived sets, never as a draft. A thread adopted
  after a start (`startThread`, plan.implement) loads like any open, so
  the brief its host stored before answering is in its first page; only a
  thread this window created empty (`adopt(meta, { created: true })`)
  waits on pushes alone.
- **The thread a window shows gets its rows as they land.** The host's push
  coalescer sends a socket's rows at once for the thread its window shows
  (`session.focus { shown }`: the focused pane's thread while the document
  is visible, whatever the window's focus or the person's attention;
  FocusSet `pushesAtOnce`), not only for the one in focus; every other
  thread's rows ride a 33 ms window, 250 ms while the box's loop lags. A
  person reading a long reply with another app focused once dropped to
  those windows and saw it in clumps.
- **Hover warms.** A tab or rail row hovered for 150 ms fetches its
  transcript (lib/hoverPrefetch.ts), which with a round trip of 200 ms is
  usually most of the way there by the click.
- A smaller first page was tried and dropped: from the Mac a 60-row tail
  (238 KiB) was no faster than the 300-row one (874 KiB) within the link's
  noise, and it would add a second request and a refold.

Measured 2026-10-22 from the Mac over the tunnel, three box threads of
3,400 to 4,200 rows in their tail, two opens each, medians of each run:

| | Before | After |
| --- | --- | --- |
| Socket round trip (`queue.list`) | 203 ms | 203 ms |
| Cold open: requests in series | 2 | 1 |
| Cold open: click to page (ms) | 333 and 272 | 215 and 175 |
| Switch back to one of the last six shown | a cold open | no request |
| On-screen markdown ready after the rows land (ms, box CPU) | 7–9 | 1–2 |

The after column's cold open is subscribe and events sent back to back
(one round trip, which is what the flag makes of them) against the box's
current build; the markdown row is the parse of the visible screen's texts
with and without the screen above them first.

## Budget

On the box (Xvfb, software GL, the profiling build), on the 2,000-row
chat:

- a cold open mounts under 40 rows and paints its rows within the app's
  own boot;
- scrolling the whole thread, either way, holds frames under 17 ms at p50
  and under 34 ms at p95, with no frame over 150 ms;
- a streamed token costs under 2 ms of main-thread time per appended row
  in React and layout together, and under 4 ms in all (the window's
  compositing included), with the live turn the only thing that renders;
- the heap stays under 35 MB with the thread scrolled through.

A regression on any of these is a bug in the transcript, not in the
thread.

## Measure

```
bun run script:measure-transcript-seed          # the database, once
TEMP_CODE_PROFILE=1 electron-vite build         # window.__app exists in profiling builds
bun scripts/measure-transcript.ts --label after # one pass; --only open|scroll|feed for one phase
```

`scripts/measure-transcript.ts` seeds a scratch userData under
/tmp/tc-transcript-measure with the chat the iOS test server seeds (500
turns of a prompt, a Read call and its answer, every seventh with a list
and a code fence), launches the built tree on a display of its own
(`xvfb-run` where there is none), and traces over CDP:

- **open**: the long thread selected, the page reloaded; ms from the page's
  time origin to `tc:transcript-blocks` and to the next paint, main-thread
  ms up to that paint, the longest task, mounted rows and DOM nodes. Both
  arms pay the same boot, which is most of the number.
- **switch**: a warm tab switch back to the long thread, to first paint.
- **scroll**: a reader's scroll (a wheel event, then 400 px per frame) to
  the top of everything, clicking "Load earlier" where it appears, then
  back down: frame times (p50, p95, max, frames over 17 and 50 ms),
  main-thread and layout ms, mounted rows and DOM nodes, the heap.
- **feed**: `window.__app.feed`, 8 s at 60 rows/s (thinking, then text
  deltas with a Read call every 40): main-thread ms per appended row, React
  commits and render ms, the top trace events, the heap.

Numbers vary run to run (open by a factor of two on a cold code cache);
compare medians of three, never one run.

## Before and after

Measured 2026-10-21 on the box (Linux, Xvfb, software GL, the profiling
build) on the 2,000-row chat; the median of three runs, with the spread in
brackets where it matters. Before is master at 8209800; after is this change.

| | Before | After |
| --- | --- | --- |
| Cold open: rows mounted / DOM nodes in the transcript | 102 / 2,096 | 14 / 322 |
| Cold open: time origin → first paint with rows (ms) | 643 [500–1,434] | 233 [233–642] |
| Cold open: main-thread ms up to that paint / longest task | 595 / 240 | 216 / 44 |
| Warm switch to the thread: first paint (ms) | 79 [45–106] | 15 [15–20] |
| Scroll to the top of everything: frames p50 / p95 / max (ms) | 50 / 150 / 1,350 | 16.7 / 16.7 / 17 |
| Scroll to the top: frames over 17 ms / over 50 ms | 416 / 187 (10 "Load earlier" pages) | 0 / 0 |
| Scroll to the top: main-thread ms / layout ms | 33,435 / 9,057 | 1,986 / 643 |
| After the scroll: rows mounted / DOM nodes / heap (MB) | 1,500 / 30,730 / 50 | 18 / 393 / 21 |
| Scroll back down: frames p50 / p95 / over 17 ms | 33 / 50 / 234 | 16.7 / 16.8 / 0 |
| Streamed turn (482 rows): React render + layout per row (ms) | 0.03 + 1.9 | 0.03 + 0.7 |
| Streamed turn: whole main thread per row (ms), thread scrolled through | 15.9 | 3.1 [3.1–3.2] |
| Streamed turn: whole main thread per row (ms), fresh open | 3.8 [3.7–4.2] | 3.1 |
| Streamed turn: task p95 / longest task (ms) | 18 / 120 | 2.5 / 21 |
| Heap after the streamed turn (MB) | 50 | 20 |

What the token numbers say: the transcript's own share of a streamed row
(React commit plus layout) is under 1 ms and no longer grows with the
thread; before, it grew with every row mounted (1,500 rows after a scroll
through the thread cost 15 ms a token). The rest of a streamed frame, about
2 ms, is Chromium's compositing of the whole window (`Layerize`, about
1.3 ms a frame), style recalculation and the engine's own frame, the same
on a fresh short thread before and after. That compositing cost is the
next lever, in the chrome around the transcript rather than in it.

Spread: open times vary by a factor of two with the code cache and the
box's load; the scroll and feed numbers are steady to within 20 % across
runs. `/tmp/tc-transcript-measure/<label>.json` keeps every run.
