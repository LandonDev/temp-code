# temp-code — harness management: implementation plan

> **Status (2026-08-11): all six milestones implemented and live-verified.**
> Each milestone has an exit test under `scripts/` (`bun run script:e2e-*`):
> claude driver (concurrent turns, tools, interrupt, resume, bad model),
> lifecycle, approvals (allow + deny), all three providers side by side,
> and orchestrator → codex subagent. Notes that changed the plan while
> verifying: the SDK boots its CLI lazily on first send (nativeId arrives
> mid-first-turn); the harness auto-approves safe commands itself so only
> dangerous calls reach the approval card; codex app-server speaks the v2
> thread/turn/item protocol (the v1 names this plan listed are gone);
> cursor-agent needs `--trust`. Remaining known gaps: codex/cursor
> approval requests are wired but not yet exercised by a live test, and
> in-harness Task subagent output is counted on its tool chip rather than
> rendered.

Goal for this phase: manage the harnesses themselves from the UI — create
sessions, send messages, show what comes back, and keep every session visible
and controllable. Orchestration (Claude spawning Codex/Cursor subagents) sits
on top of this and is specced at the end.

## Where we are

The scaffold already has:

- **Shared contract** (`src/shared/`): capability catalog, normalized
  `AgentEvent` schema, typed WS contract (request/response + per-session
  subscription pushes).
- **Server** (`src/main/server/`): WS server on a dynamic localhost port,
  `node:sqlite` store (session tree + append-only event log), session
  registry with live driver handles, three drivers:
  - `claude` — Agent SDK, streaming input, delta events, resume. Written
    against verified SDK types; needs a live end-to-end pass.
  - `codex` — `codex app-server` JSON-RPC transport. Method/event names
    unverified (marked experimental).
  - `cursor` — `cursor-agent` stream-json, process-per-turn. Unverified.
- **Renderer**: session sidebar (tree, status dots), transcript (delta
  folding, tool blocks), prompt bar, new-session modal fed by the catalog.
- **Component layer**: shadcn base + ReUI (radix-nova, Pro key wired),
  BeUI motion pieces in `components/motion/`, Beautiful UI landing zone in
  `components/bui/` with an adaptation checklist.

Design rules that hold for everything below:

1. The app never holds provider credentials. Drivers run official harnesses
   under the user's local logins.
2. The UI renders only the normalized event schema. Provider payloads stop
   at the driver.
3. The event log is the source of truth. Replays must reproduce the
   transcript exactly.

## Milestone 1 — Claude driver, verified end to end

The claude driver is written; make it true.

- Run a real session: create → init event → send → deltas → tool calls →
  result. Fix mapping drift against the real stream (block indexes,
  interleaved thinking, parallel tool calls, subagent `parent_tool_use_id`).
- Resume: kill the app mid-session, relaunch, send again — the driver must
  resume via `nativeId` and the transcript must replay from SQLite.
- Errors: `claude` missing, not logged in, model rejected. Each must land as
  an `error` event plus `status: error`, visible in the sidebar.
- Interrupt: verify `query.interrupt()` stops the turn and status returns
  to idle.
- Decide turn-complete accounting: read the last `result` per turn
  (SDK totals are cumulative in streaming sessions — don't sum).

Exit test: two concurrent Claude sessions in different cwds, both streaming,
kill and relaunch the app, both transcripts intact, both resumable.

## Milestone 2 — session lifecycle in the UI

What "managing harnesses" means concretely:

- **Archive / delete** session (dispose handle, keep or drop the log).
- **Restart** an errored session (new driver handle, same log + nativeId).
- **Idle disposal**: after N minutes idle, dispose the handle, keep the
  session listed; next send lazily restarts via resume. This is what keeps
  dozens of sessions cheap.
- Sidebar affordances for the above via context menu (ReUI dropdown), not
  buttons on every row.
- A small server-status strip: connected/reconnecting, session count.
- Directory picker for cwd (Electron dialog via IPC) instead of the text
  field.

## Milestone 3 — show them properly

Replace the plain transcript surfaces with adapted Beautiful UI primitives
(copy → re-token → wire, per `components/bui/README.md`):

- **Streaming Text** for `assistant-text`; markdown render; **Code Block**
  with shiki (highlighter in a worker; highlight the final block, not every
  delta).
- **Thinking** collapsed by default.
- **Tool Chips** for `tool-call`/`tool-result` pairs (name, one-line
  summary, expand for payloads).
- **Task Rows** in the sidebar for child sessions once orchestration lands.
- **Prompt Bar** upgrade: model shown, interrupt, queued-while-running
  messages.
- Virtualize the transcript (`@tanstack/react-virtual`) once folding moves
  out of render: fold deltas into blocks incrementally in the store (append
  to the last block on delta) instead of refolding the whole log each frame.
- Motion: BeUI stateful button for send/interrupt; one easing scale
  (`lib/ease.ts`) app-wide.

## Milestone 4 — approvals

The harness asks; the user answers in the UI.

- Claude: pass `canUseTool` in the driver; emit a new `approval-request`
  event; add `session.approve` to the WS contract; render Beautiful UI's
  **Approval Card**; resolve the SDK promise on answer. Timeout → deny.
- Codex: same surface driven by `applyPatchApproval` / `execCommandApproval`
  server→client requests (verify names in Milestone 5).
- Per-session policy in the new-session modal: safe (ask), edits-auto
  (current default), full-auto (worktree sessions only, later).

## Milestone 5 — Codex and Cursor drivers, verified

Transport is done for both; verify the protocol against the installed CLIs.

- Codex: check method/notification names against `codex app-server` docs
  (initialize / newConversation / sendUserMessage / interruptConversation,
  `codex/event` payloads). Fix mapping, wire reasoning effort, patch/tool
  events beyond exec (`apply_patch` begin/end), token counts.
- Codex gotchas (from Aliax): resolve the real binary — the user's shell
  wraps `codex` in a function (Aliax proxy); spawn with a login-shell PATH
  because a GUI app's PATH lacks `node` and the npm shim dies with exit 127.
- Cursor: verify `cursor-agent -p --output-format stream-json` event shapes
  and `--resume`; map tool events properly.
- Add a doctor check per provider on app start (binary found, logged in,
  version) surfaced in the new-session modal instead of failing at first
  send.

Exit test: one session per provider side by side, all streaming, all
interruptible.

## Milestone 6 — orchestration (spec, next phase)

Held to the design agreed earlier; build after 1–5:

- MCP server inside our Node server exposing `spawn_agent`, `send_to_agent`,
  `wait_for_agent`, `list_agents`; enums generated from the catalog.
- The orchestrator is not special: any Claude session given this MCP
  toolset plus a router-rubric system prompt (the model table from
  CLAUDE.md). Children appear in the same session tree via `parentId` —
  the UI already renders it.
- `agent-spawned` events + Task Rows give live subagent visibility.
- Worktree isolation default for writing subagents.

## Aliax integration

Aliax (`~/IdeaProjects/Aliax`) is a menu-bar account manager for the same
three CLIs. Survey conclusions:

**Copy in now (Milestone 5 support):**

- `src/main/procs.ts` — process discovery: pgrep/tty/cwd classification,
  ancestor exclusion, headless-vs-terminal detection (headless == exactly
  what our drivers spawn), `killAndWait`. Use it for the doctor checks and
  orphan cleanup after crashes.
- `src/main/sessions.ts:14-56` — newest-session-id-for-cwd resolvers for
  `~/.claude/projects` and `~/.codex/sessions`; fallback when we lack a
  `nativeId`.
- The spawn lessons above (PATH, shell-function shadowing, and never launch
  dev/packaged builds from a Claude shell without
  `env -u ELECTRON_RUN_AS_NODE` — already bitten us once in setup).

**Copy when we store anything secret (not yet needed):**

- `src/main/vault.ts` — safeStorage vault including `decryptWithPastKey`
  (survives app renames; we WILL rename temp-code, so if we ever store
  secrets, take this file first).
- `src/main/keychain.ts` — 12-line dependency-free Keychain shim.

**Later, if we want usage/stats:** `src/main/stats/` — incremental JSONL
indexer keyed by (path, mtime, size, offset); right shape for mining harness
transcripts into per-session token/cost stats.

**Do not copy:** proxy.ts / shim.ts / shell-integration (~900 lines solving
instant account switching for terminals we don't own — we spawn our
children and can set env per child).

**Running both apps (conflicts to handle in Milestone 5):**

1. Aliax's instant switching writes `env.ANTHROPIC_BASE_URL` into
   `~/.claude/settings.json`, which beats exported env. Our Claude sessions
   would silently route through Aliax's proxy. Either accept it (it works,
   and multi-account is a feature) or pin per-child env explicitly.
2. An account switch in Aliax swaps credentials under our live sessions.
   Detect via its `~/.aliax/proxy.json` liveness marker and surface a
   banner ("accounts switched — session may need restart") rather than
   fight it.
3. Long term: Aliax has no control API today, but `accounts.listServices()`
   / `accounts.activate()` are clean functions and its gateway is an
   existing http server — a ~50-line localhost control endpoint would let
   temp-code show and switch accounts per session. Worth a PR to Aliax
   when multi-account orchestration matters.

## Order and size

1 (Claude verified) → 2 (lifecycle) → 3 (show properly) are sequential and
each is roughly a day of focused work. 4 (approvals) and 5 (codex/cursor
verify) can go in either order after. 6 is its own phase.
