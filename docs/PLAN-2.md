# temp-code — flawless orchestration + shared project context: implementation plan

> **Status (2026-08-15): all four milestones implemented and test-verified.**
> Exit tests under `scripts/` (`bun run script:e2e-supervision`,
> `script:e2e-shared-context`, `script:e2e-thread-refs`,
> `script:e2e-app-tools`). Notes that changed the plan while building:
> supervision tools are exercised by calling the MCP tool handlers
> directly (deterministic — no orchestrator model in the loop); claude and
> codex report cumulative token totals per session while cursor reports
> per turn, so `check_agent` sums accordingly; the M10 cross-provider
> bridge shipped in the same pass as a dependency-free
> `scripts/app-mcp-bridge.mjs` (node's built-in WebSocket, ndjson MCP)
> registered per codex thread via the `thread/start` config override —
> cursor-agent has no per-run MCP config flag, so cursor preambles state
> that app tools don't reach that harness and handoffs go through the user.
> One codex gotcha found live: first use of an MCP server fires a
> `mcpServer/elicitation/request` trust prompt, and the driver's old
> fail-closed reply killed the call as "user rejected MCP tool call" — the
> driver now pre-trusts our own `app` bridge, honors `auto`, and renders
> other servers' prompts as approval cards.

Four milestones, in dependency order:

- **M7 — Orchestrator supervision**: the orchestrator can see what its
  agents are doing mid-flight, unstick waiting ones, and collect results
  without blind spots.
- **M8 — Project-global context**: everything that happens in a project's
  threads becomes shared context every other thread (and every provider)
  can read.
- **M9 — Thread references**: `@`-mention any thread of any project in the
  composer; the model gets a readable digest of it.
- **M10 — App tools**: every thread knows what it is and can drive the
  app — start an implementation thread from its plan, seed a planning
  thread from one or more chats, list and read sibling threads.

M9 depends on M8's digest machinery; M10 depends on both (it reuses the
digests for seeding and the mirrors for awareness). M7 is independent and
first because it is small and unblocks real orchestration use today.

Design rules carried over from PLAN.md: the app never holds credentials;
the UI renders only the normalized event schema; the event log is the
source of truth. New rule for this phase: **files are the substrate for
shared context** — anything one thread should know about another lives as
a readable file inside the project (`.temp-code/`), because a file is the
one interface all three harnesses already have.

---

## M7 — Orchestrator supervision: flawless mode

### What is wrong today

The spawn/route/enforce side is done (structured rules, caps enforced in
`spawn_agent`, tool denial in the driver). The supervision side has holes:

1. **No mid-turn visibility.** While a child runs, the orchestrator sees
   only the word `running`. `wait_for_agent` timing out returns
   `{status: 'timeout'}` and nothing else — wait longer or interrupt blind.
2. **A `waiting` child is a dead end.** `registry.answer()` and
   `registry.approve()` exist (`sessions.ts:317`) but are not orchestrator
   tools. A child asking a clarifying question stalls the fleet until the
   human notices.
3. **`wait_for_agent`'s "reply" is wrong.** `lastAssistantText()`
   (`orchestration.ts:51`) joins every final assistant text in the child's
   whole log, then tails 8000 chars — after three turns the "latest reply"
   is a smear of all three.
4. **`list_agents` omits the task.** In a long fleet the orchestrator maps
   ids to tasks from memory.
5. **Waiting is serialized.** One `wait_for_agent` call per child means a
   five-agent fan-out is collected in spawn order, not completion order.
6. **No kill switch.** A runaway child can only be stopped by the user.

### Changes — all in `src/main/server/orchestration.ts` unless noted

**New tool `check_agent`** — the supervision window. Non-blocking; returns
a condensed, human-readable view of one child *right now*:

```
check_agent(agentId) → {
  status, title,
  idleForSeconds,          // now - lastActivity; detects hangs
  currentTurn: {
    toolCalls,             // last ≤10 of this turn, one line each:
                           //   "Edit src/foo.ts", "Bash: npm test (failed)"
    lastText,              // tail (≤2000 chars) of streamed assistant text
  },
  pending,                 // see "waiting" below; null unless waiting
  tokens: { input, output, costUsd },   // summed turn-complete events
}
```

Implementation: read `eventsAfter(agentId, 0)`, slice from the last
`user-text` row (that slice is "the current/latest turn" — same fix as
point 3), render tool-call events through a small summarizer (tool name +
the one obviously-primary input field: `file_path`, `command`, `pattern`;
fall back to the name alone). No new state anywhere — it is a pure read of
the event log, so it works identically for claude, codex and cursor
children.

**Fix `wait_for_agent`:**

- Reply = text of the *latest turn only* (events after the last
  `user-text`), not the whole log.
- Accept `agentIds: string[]` (keep `agentId` as sugar for one) plus
  `mode: 'any' | 'all'` (default `any`). `any` returns the first child to
  settle (`Promise.race` over the existing `waitForSettled`), so fan-outs
  collect in completion order. Return shape gains `agentId` so the caller
  knows who settled.
- When the settled status is `waiting`, include `pending`: the last
  unresolved `question-request` (full questions/options payload) or
  `approval-request` (tool name + title) from the log. Unresolved = no
  matching `question-resolved`/`approval-resolved` row after it. The
  orchestrator now *knows what the child is stuck on* instead of just that
  it is stuck.

**New tool `answer_agent(agentId, requestId, answers)`** — resolves a
child's pending `question-request` via `registry.answer()`. Questions
only. **Approvals stay human-only, deliberately**: the permission policy
is the user's grant, and an orchestrator approving its own children's
dangerous calls would nullify it. When `pending` is an approval, the
mechanics prompt tells the orchestrator to say so to the user and keep
working on other agents. (Children already inherit the parent's policy at
spawn, so a user who runs the orchestrator on `auto` never hits this.)

**New tool `interrupt_agent(agentId)`** — `registry.interrupt()`. For
runaway or clearly-off-track children; pair with `send_to_agent` to
redirect, or spawn a replacement.

**`list_agents` gains `title` and `idleForSeconds`.** Nothing else — it
stays the cheap fleet overview; `check_agent` is the deep view.

**`spawn_agent` returns `title`** along with `agentId` so the
orchestrator's own bookkeeping starts correct.

**Guard `send_to_agent`/`check_agent`/etc. to actual children**: every
tool that takes `agentId` verifies `parentId === parent.id` and returns a
corrective refusal otherwise (today `send_to_agent` will happily message
any session id it hallucinates).

**Mechanics prompt** (`ORCHESTRATOR_MECHANICS`) gains a supervision loop
paragraph: after spawning, check long-running agents periodically with
`check_agent` (a stalled `idleForSeconds` or a wrong-direction tool trail
is a signal to redirect or interrupt); answer questions with
`answer_agent`; approvals belong to the user — surface them; collect with
`wait_for_agent mode:any` and verify before relaying. Also document that
`wait_for_agent` timeouts are normal for long tasks — check, then wait
again.

### Not doing (decided against)

- **Orchestrator-approves-permissions** — see above.
- **Push notifications into the orchestrator's turn** (injecting "child X
  finished" mid-turn). The SDK cannot interrupt a turn with new context;
  `wait_for_agent mode:any` gives the same effect at the model's own pace.
- **Auto-restart of errored children.** An error is information; the rules
  (`escalate`) already tell the orchestrator what to do with it.

### Exit test (`scripts/e2e-orchestrator-supervision`)

Scripted against a live registry, no UI: orchestrator session spawns a
claude child + a codex child; while the codex child runs, `check_agent`
shows its tool trail; child asks a structured question →
`wait_for_agent` returns `waiting` + the pending payload → `answer_agent`
resolves it → child completes; `wait_for_agent` with both ids and
`mode:'any'` returns the first finisher; reply contains only the final
turn's text; `interrupt_agent` stops a deliberately-long child;
`send_to_agent` to a non-child id is refused. Typecheck both configs;
relaunch the app.

---

## M8 — Project-global shared context

### Goal

Work in a planning thread; every other thread of the project knows the
plan exists and what it says. Ask a chat thread "where did we leave off?"
and it answers from what the implementation thread actually did. New
threads start already-oriented. All of it provider-agnostic.

### The substrate: `.temp-code/` inside the project cwd

Already exists (plan docs), already git-excluded (`ensureLocalExclude`),
already filtered from the Changes rail, already writable by every harness
sandbox because it is inside the cwd. Final layout:

```
.temp-code/
  PROJECT.md            # distilled journal — models append, humans read
  plan-<sessionId>.md   # existing planning-thread deliverables
  threads/<slug>.md     # mirrored transcripts, one per thread (M8)
  refs/<sessionId>.md   # on-demand digests for @thread references (M9)
```

Project-scoped on purpose: a worktree project's context lives in its
worktree, isolated like its code. Cross-project sharing is M9's job
(explicit references), not ambient.

### Piece 1 — transcript mirroring (`src/main/server/mirror.ts`, new)

After every completed turn, write the thread's readable transcript to
`.temp-code/threads/<slug>.md`.

- **Trigger:** in `SessionRegistry.append()`, on a `turn-complete` event
  for a session with a `projectId`, schedule `mirrorSession(sessionId)`
  debounced ~2s per session (a multi-agent burst writes once).
- **Content:** frontmatter (`title`, `threadType`, `provider · model`,
  `status`, `updated` ISO timestamp, `sessionId`) then the dialogue.
  Reuse the `transcriptHandoff()` walk (`sessions.ts:32`) but richer:
  `## User` / `## Assistant` sections, plus one-line tool actions rendered
  through M7's summarizer (`- Edit src/foo.ts`) so a reader sees *what was
  done*, not just what was said. No thinking, no tool payloads.
- **Slug:** `<sessionId>-<kebab title, first 40 chars>`; sessionId prefix
  keeps it stable when titles change (overwrite, never duplicate).
- **Size cap:** 60k chars, head-trimmed with a `[earlier turns trimmed]`
  marker — same philosophy as the handoff cap.
- **Writes are atomic** (tmp file + rename) so a harness mid-read never
  sees a half file.
- **Subagents mirror too**, into the *parent project's* cwd (children of
  an orchestrator may run in throwaway worktrees; their context belongs to
  the project). Slug prefix `agent-`; frontmatter records the parent
  session.
- **Deletion:** `registry.delete()` removes the thread's mirror file.
  Archived threads keep theirs (still context).

### Piece 2 — the project preamble (`threads.ts`)

Extend the existing first-send `<thread-instructions>` mechanism — it is
already provider-agnostic and already invisible in the transcript. On the
first message of any thread with a `projectId`, prepend a
`<project-context>` block *built at send time*:

```
<project-context>
This thread belongs to project "<name>" (workspace "<ws>", branch <b>).
Shared project context lives in .temp-code/:
- PROJECT.md — the project journal. Read it FIRST.
- threads/ — transcripts of the project's other threads:
    · plan: "Auth overhaul" (idle, updated 2h ago) — threads/ab12-auth-overhaul.md
    · task: "Implement login flow" (running, updated 3m ago) — threads/cd34-implement-login.md
- plan-*.md — plan documents.
Consult transcripts when the user refers to other work. This index is a
snapshot from thread creation — re-list .temp-code/threads/ when you need
current state.

Append to PROJECT.md (a dated bullet under ## Log) whenever this thread
produces a durable outcome: a decision made, a plan written, work merged,
an approach abandoned. Keep entries to one or two lines. Never rewrite
others' entries.
</project-context>
```

Index only — titles, states, paths — never contents; the model reads what
it needs. Built server-side in `send()` from `sessionsOfProject()` + the
mirror slugs, so it costs one directory listing.

**Preamble refresh for long-lived threads:** the block ships once, so the
instruction "re-list when you need current state" carries the weight; the
mirror files themselves are always fresh.

### Piece 3 — PROJECT.md, the journal

- **Seeded at `createProject()`**: title header, one-line project
  description placeholder, `## Log` with a creation entry
  (`- 2026-08-15 — project created (worktree tc/auth-overhaul)`).
- **Model-maintained** after that, per the preamble contract above. The
  app never writes to it again except one case: `registry.delete()` of a
  planning thread appends `- <date> — plan "<title>" thread deleted` so
  the journal never dangles into a missing file.
- Why a journal and not generated state: the distillation ("we chose JWT
  over sessions because…") is judgment, and the models are the ones who
  have it at the moment it happens. The mirrors are the raw record; the
  journal is the summary; the preamble is the map.

### Piece 4 — plan ↔ implementation sync (closing the open question)

Decision: **the plan document stays live, one-way, plan-file-as-truth.**
The implementation preamble (`threadPreamble`, `implementation` case)
gains: "As you complete tasks from the plan's `## Tasks` checklist, tick
them (`- [x]`) in the plan file with Edit." Planning threads already keep
the file current from their side. No app-side sync engine, no two-way
merge — both sides edit one markdown file, which is exactly what markdown
checklists are for. The plan view (which already polls `file.read`)
renders progress for free.

### Exit test (`scripts/e2e-shared-context`)

Live registry: create a project → PROJECT.md seeded. Run a planning
thread turn → mirror file appears with frontmatter + dialogue; plan doc
exists. Start a second (chat) thread → its outbound first message contains
the `<project-context>` block listing the planning thread's mirror by
title and path. Complete a turn that edits files → mirror shows the
one-line tool actions. Delete the thread → mirror gone, journal entry
appended. Verify mirrors for a codex child land in the project cwd. Cap:
a >60k transcript head-trims. Typecheck; relaunch.

---

## M9 — Reference other threads in a message

### Goal

Type `@` in the composer and mention a thread — same project or any other
— the way you mention a file today. The model receives a readable digest
of that thread, regardless of provider, regardless of sandbox.

### Resolution model: digest files, not inline paste

When a message with thread references is sent, the server writes a fresh
digest of each referenced thread into the *current* project's
`.temp-code/refs/<refSessionId>.md` and rewrites the mention token to that
path. Why files, why local:

- **Sandboxes.** A codex/cursor child cannot necessarily read another
  project's absolute path; it can always read its own cwd. Copying the
  digest in makes cross-project references work everywhere.
- **Freshness.** The digest regenerates on every send that references the
  thread — never stale, and deleting the source thread later cannot break
  an old message (the digest a past message referenced is a snapshot; that
  is a feature).
- **Reuse.** The digest *is* M8's mirror content (same serializer, same
  cap) plus a header naming the source project and a pointer to the
  thread's plan file when it has one. For a same-project reference the
  digest is still written to `refs/` rather than pointing at `threads/` —
  one uniform shape, and the referenced snapshot survives even if the
  mirror later trims.

### Contract & server (`contract.ts`, `sessions.ts`)

Extend `AttachmentSchema` (`events.ts:45`) minimally:

```ts
kind: z.enum(['image', 'file', 'thread']),
sessionId: z.string().optional()   // set when kind === 'thread'
```

`session.send` already carries attachments. In `registry.send()`, before
`handle.send()`: for each `kind: 'thread'` attachment, generate the digest
file, then rewrite the message's `@thread:<id>` token to
`@.temp-code/refs/<id>.md (thread "<title>" from project "<name>")`. The
attachment row in the visible transcript keeps the thread's *title* (the
collapsed row stays human — no paths until expanded, per the standing
rule). Thread attachments are not forwarded to the harness as file
attachments — the rewritten path in the text is the reference; claude,
codex and cursor all follow `@path` conventions already.

Sessions without a `projectId` (legacy/unsorted) fall back to inlining the
digest in a `<thread-reference>` block capped at 12k chars — no `.temp-code/`
to write into.

### UI (`PromptBar.tsx`)

- `triggerAt` unchanged — `@` keeps one menu. `matches` becomes grouped:
  **Files** (existing `rankFiles`) then **Threads**, ranked by the same
  query against thread titles. Thread candidates come straight from the
  store's `sessions` map (already live via meta pushes — zero fetching):
  every non-archived root thread *except the current one*, current
  project's first, then other projects'. Empty query shows top files +
  the 3 most recently active threads.
- Thread rows render: status dot, title, project name (muted, only when
  not the current project), relative time — mirroring the file rows'
  name/dir layout. Keyboard behavior identical (one flat list for
  arrows/enter).
- Accepting a thread inserts `@thread:<sessionId>` into the text and adds
  a chip (message-circle icon, thread title, removable) via the existing
  `fileRefs` pattern — one `refs` list holding both kinds. On submit the
  chips ride along as `kind:'thread'` attachments; the raw
  `@thread:<id>` token in the text is what the server rewrites.
- Transcript rendering: the user-text block renders `@thread:<id>` tokens
  as the thread's title (store lookup), styled like a mention — the id
  never shows.

### Exit test (`scripts/e2e-thread-refs`)

Two projects, A and B. A thread in A does distinctive work. From a thread
in B, send a message with a `kind:'thread'` attachment referencing it →
`B/.temp-code/refs/<id>.md` exists, contains A's dialogue and names
project A; the outbound text contains the rewritten local path; the model's
reply demonstrates it read the digest (ask it to quote the distinctive
fact). Same-project reference works; referencing a planning thread's
digest includes the plan path; a projectless session gets the inline
fallback. UI: typecheck + a manual pass over the grouped menu. Relaunch.

---

## M10 — App tools: threads that know and drive the app

### Goal

Every thread is a first-class citizen of the app, not a chat that happens
to run inside it. Concretely:

- A thread **knows what it is**: its type, its project, its plan file, its
  siblings — and behaves accordingly.
- A thread **can operate the app**: a planning thread whose plan is
  approved starts the implementation thread itself (with the model/effort
  the user asked for); a chat that has crystallized into a real piece of
  work starts a planning thread seeded from itself — or from several
  chats; any thread can look up and read its siblings on demand instead of
  waiting for the preamble snapshot.

### The toolset (`src/main/server/apptools.ts`, new)

Same pattern as `orchestratorMcp`: an in-process SDK MCP server built per
session, registry injected. Attached to **every claude session**, not just
orchestrators (codex/cursor: see the bridge below).

```
app_list_threads({ allProjects?: boolean })
  → threads of this project (or all): id, title, threadType, status,
    provider · model, planPath, mirror path, updated. The live version of
    the preamble index.

app_read_thread({ threadId })
  → the M9 digest of that thread, returned inline (capped). How a
    planning thread ingests the chats it is planning from.

app_start_thread({
  threadType,                    // chat | planning | implementation | orchestration
  provider, model, reasoning,    // validated against the catalog, like spawn_agent
  projectId?,                    // defaults to this thread's project
  planPath?,                     // implementation/orchestration: the plan to work from;
                                 //   defaults to THIS thread's planPath when it has one —
                                 //   "start implementation from this plan" is zero-config
  seedThreadIds?,                // digests of these threads prepended to the first
                                 //   message (M9 machinery) — "plan from these chats"
  firstMessage,                  // the kickoff message, written by the calling model
  title?
})
  → { threadId, title }. Creates the thread via registry.create() (thread
    title rules, planPath wiring, permission inherited from the calling
    session) and sends firstMessage through registry.send() — so the
    preambles, planSeed, and project-context block all apply exactly as if
    the user had typed it. The new thread appears in the strip and starts
    working immediately, fully visible.
```

No `app_delete_thread`, no archive, no rules editing — destructive and
policy surfaces stay human. `app_start_thread` is the one write, and its
guardrail is social, not mechanical: the thread-type instructions (below)
say to start threads only when the user asked for it or agreed to the
handoff — plus the new thread is loudly visible in the UI the moment it
exists, and it costs the user one click to interrupt.

### Thread-type identity (`threads.ts`, expanded)

`threadPreamble()` grows from behavior-only to identity + character +
handoffs. Every project thread's first message now states: what type of
thread this is, which project and branch it serves, where its plan file
is, how it should carry itself — including its **question posture** — and
**what its exits are**, phrased as instructions.

Question posture matters because structured questions are now first-class
in the UI (multichoice cards, answered inline): chat and planning threads
should use them freely; implementation threads should mostly not. Each
type's preamble says so explicitly:

- **chat** — *ideate and converse.* Think out loud with the user, explore
  alternatives, challenge assumptions; nothing here is a deliverable.
  "Ask questions liberally — use the structured question tool whenever a
  choice would sharpen the discussion; the UI renders them natively.
  When the discussion turns into real work the user wants done, offer to
  start a planning thread; on their go-ahead, `app_start_thread` with
  `seedThreadIds: [this]` so the plan starts from this conversation."
- **planning** — *gather context, force decisions.* (Existing plan-file
  contract, unchanged.) "Your job is to leave no open decision in the
  plan: read the codebase, read the project context, and put every real
  choice to the user as a structured question — options with trade-offs,
  not essays. Ask early and often; a plan built on unasked questions is a
  guess. You never implement — when the user approves the plan,
  `app_start_thread` an implementation (or orchestration, if the plan
  fans out) thread pointing at this plan file, with whatever model/effort
  the user wants for the build. Confirm that choice if they haven't said."
- **implementation** — *execute on given context.* (Existing todo contract
  + M8's tick-the-plan rule.) "The plan and project context are your
  brief: read them first, dig up whatever else you need from the codebase
  yourself, and implement. Questions are the exception, not the method —
  the planning thread already asked them. Reserve them for genuine
  blockers: a contradiction in the plan, a destructive step, missing
  access. If the work reveals the plan is wrong, say so and offer a
  planning thread rather than silently replanning inline."
- **orchestration** — *orchestrate.* Unchanged: M7 mechanics + the user's
  conduct/routing rules own this type; delegation posture (and whether it
  may touch anything itself) comes from those rules, not from here.

This is also where "the model knows everything you are doing" closes:
identity from the preamble, current state from `app_list_threads` /
`app_read_thread`, history from M8's mirrors and journal — three layers,
one file substrate, no special cases.

### Cross-provider: the stdio bridge (second phase of M10)

In-process SDK MCP servers are claude-only. Codex and cursor both speak
MCP via config, so the same toolset reaches them through a thin bridge:
`scripts/app-mcp-bridge.ts` — a stdio MCP server that connects back to the
app's WS port (port + session id via env vars set by the driver) and
forwards the three tools as `app.*` WS methods (`app.listThreads`,
`app.readThread`, `app.startThread` added to the contract; the claude
in-process path calls the same registry functions directly). The codex
driver registers it in `newConversation` MCP config; cursor via its MCP
config flag. Ship claude-first — the bridge is additive, changes no
interfaces, and can land as its own commit. Until it lands, codex/cursor
thread preambles state plainly that app tools are claude-side only and
handoffs go through the user.

### Exit test (`scripts/e2e-app-tools`)

Live registry: a chat thread calls `app_list_threads` and sees its
siblings. A planning thread with a finished plan calls `app_start_thread
{threadType:'implementation', provider:'codex', planPath: own}` → new
thread exists with the right type/model/planPath, its first outbound
message carries thread-instructions + plan seed, and it starts running; an
`agent`-style visibility check confirms it appears via meta push. A chat
calls `app_start_thread {threadType:'planning', seedThreadIds:[two
chats]}` → the planning thread's first message embeds both digests.
Catalog validation: bad model id refused with a corrective message.
Typecheck; relaunch.

---

## Order, size, risks

**M7 → M8 → M9 → M10.** M7 is a day: one file plus prompt text, mostly
pure reads of the event log. M8 is the heart — mirror writer + preamble +
journal seed, a day and a half with the test. M9 is a day: digest reuse
makes the server side thin; the composer grouping is the bulk. M10's
claude phase is a day (the toolset is thin over `registry.create`/`send`
and the M9 digester); the codex/cursor bridge is a further day and ships
separately.

Risks and their answers:

- **Mirror write storms** (orchestrator fleets completing turns
  together) → per-session debounce + atomic writes; mirrors are
  per-session files so writers never contend.
- **Preamble bloat** in projects with many threads → index caps at the 20
  most recently updated threads with a "…and N older — list the directory"
  line.
- **Models forgetting to journal** → acceptable-by-design; the mirrors
  are the safety net, and the preamble instruction can be tuned without
  code changes.
- **`.temp-code/` growth** → mirrors are capped and overwrite in place;
  `refs/` regenerates per reference. If it ever matters, a sweep on
  project open deleting `refs/` entries older than 30 days is ten lines.
- **Two threads editing PROJECT.md concurrently** → append-only bullets
  under one heading make collisions near-impossible to corrupt; worst
  case is interleaved bullets, which is still a correct journal.
- **Model-started thread sprawl** → `app_start_thread` is instruction-
  gated (only on user ask/agreement), every new thread is immediately
  visible in the strip, and it inherits the caller's permission policy —
  it can never grant itself more than the user granted. If sprawl shows
  up in practice, a per-thread started-threads cap slots into the same
  refusal pattern as the M7 spawn caps.
- **Bridge trust** → the WS server is localhost-only and single-user; the
  bridge adds no new surface beyond what the renderer already has. The
  `app.*` methods validate session ids against the registry like every
  other method.
