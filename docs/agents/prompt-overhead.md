# What a fresh thread pays before it starts

Every thread's first model request carries a fixed overhead before the person's
first word: the harness's own system prompt and tools, the instruction files it
attaches, the host's mechanics and app tools, and the first message's wrapper.
When that overhead sits near the compaction threshold, the window refills to the
limit on every request and the thread compacts again and again (the thrash).
This file keeps the measured numbers; `bun run script:measure-first-request`
(scripts/measure-first-request.ts) makes them.

## Method

An isolated headless instance of the built tree with the gateway's shape trace
on (`TEMP_CODE_GATEWAY_SHAPE=1`, src/main/server/gatewayShape.ts) reads this
host's vault read-only. A detached worktree of the tree's HEAD is its project
(so its CLAUDE.md is the tree's) with the house preamble as the project's rules.
One chat thread per model at low effort is sent "Reply with the word ok and
nothing else." The first `[gateway:shape]` line of each thread on its own model
is its first request: every part by bytes, each scaled to the input tokens the
answer reported (a part's ≈ tokens is its share of the bytes times that total).
A `<system-reminder>` is split on its `Contents of <path>` headings, so each
instruction file is its own row. Muse Code talks to Meta itself, with no gateway
lane, so it has no row here.

What the isolated instance leaves out: its skills store is empty, so neither the
skill listing nor a `/skill` expansion shows (the sighting's listing was about
14k tokens; Codex's first message carried two design skills, about 15k tokens,
before skills went by pointer); and its auto memory is the project's memory dir
for the scratch worktree.

## The two sightings

- **Claude Opus 5.5 on the box (`NdDwla3D-WUO`).** The first request held
  167,400 input tokens on a 200k window. Project CLAUDE.md was ~121k tokens of it
  (296,940 characters, 72%), tool definitions ~21k, the skill listing ~14k, auto
  memory ~7k, the system prompt ~6k. After every compaction Claude Code attaches
  the instruction files again (29 `instructions` attachments in the CLI's
  transcript), so each window went from ~11.5k back to ~170k within one request.
  Claude Code's own guard ended five turns with "Autocompact is thrashing". CLAUDE.md
  grew from 7.9 KB on 2026-10-15 to 305 KB on 2026-11-10.
- **Codex gpt-6.1-sol on the Mac (`3Y4TQCSjiHQk`).** Turn 1 ran with
  `model_context_window` 258,400 (272,000 × 0.95, Codex's window for a model it
  has no metadata for) and every tool inline: 309,125 input tokens on its first
  request, a compaction after every request. Turn 2 had the model's metadata
  (475,000 = 500,000 × 0.95), tools in code mode, and a first request of 42,278.

## before on the box

2026-11-11, tempcode-box, tree c27aacf02, 2.1.311 (Claude Code), codex-cli 0.163.0. One thread per model at low effort, its first request.

### claude claude-sonnet-5-5

First request: 421,697 bytes, 160.8k input tokens of a 200.0k window (80.4%).

| Part | Bytes | ≈ tokens | Share |
|---|---:|---:|---:|
| Project CLAUDE.md | 305,539 | 116.5k | 72.5% |
| Tool definitions (27, 1 deferred) | 46,889 | 17.9k | 11.1% |
| Auto memory MEMORY.md | 18,401 | 7.0k | 4.4% |
| Other messages | 15,531 | 5.9k | 3.7% |
| System prompt | 14,947 | 5.7k | 3.5% |
| JSON framing and settings | 5,945 | 2.3k | 1.4% |
| User CLAUDE.md | 5,705 | 2.2k | 1.4% |
| The first message | 5,623 | 2.1k | 1.3% |
| Other system reminders (skills, deferred tools, context) | 2,778 | 1.1k | 0.7% |
| field:metadata | 212 | 81 | 0.1% |
| field:context_management | 59 | 22 | 0.0% |
| field:thinking | 42 | 16 | 0.0% |
| field:output_config | 16 | 6 | 0.0% |
| field:max_tokens | 6 | 2 | 0.0% |
| field:stream | 4 | 2 | 0.0% |

Tools by group: builtin 28,313, mcp:app 10,618, mcp:orchestrator 7,958.

### claude claude-opus-5-5

First request: 422,009 bytes, 160.9k input tokens of a 200.0k window (80.5%).

| Part | Bytes | ≈ tokens | Share |
|---|---:|---:|---:|
| Project CLAUDE.md | 305,539 | 116.5k | 72.4% |
| Tool definitions (27, 1 deferred) | 46,578 | 17.8k | 11.0% |
| Auto memory MEMORY.md | 18,401 | 7.0k | 4.4% |
| Other messages | 16,026 | 6.1k | 3.8% |
| System prompt | 14,947 | 5.7k | 3.5% |
| JSON framing and settings | 5,946 | 2.3k | 1.4% |
| The first message | 5,750 | 2.2k | 1.4% |
| User CLAUDE.md | 5,705 | 2.2k | 1.4% |
| Other system reminders (skills, deferred tools, context) | 2,778 | 1.1k | 0.7% |
| field:metadata | 212 | 81 | 0.1% |
| field:context_management | 59 | 22 | 0.0% |
| field:thinking | 42 | 16 | 0.0% |
| field:output_config | 16 | 6 | 0.0% |
| field:max_tokens | 6 | 2 | 0.0% |
| field:stream | 4 | 2 | 0.0% |

Tools by group: builtin 28,002, mcp:app 10,618, mcp:orchestrator 7,958.

### codex gpt-6.1-sol

First request: 109,380 bytes, 22.6k input tokens of a 475.0k window (4.8%).

| Part | Bytes | ≈ tokens | Share |
|---|---:|---:|---:|
| Developer messages | 56,151 | 11.6k | 51.3% |
| Tools in code mode (additional_tools) | 39,527 | 8.2k | 36.1% |
| User messages (AGENTS.md, context, the message) | 11,896 | 2.5k | 10.9% |
| field:client_metadata | 1,466 | 303 | 1.3% |
| JSON framing and settings | 190 | 39 | 0.2% |
| field:reasoning | 38 | 8 | 0.0% |
| field:prompt_cache_key | 36 | 7 | 0.0% |
| field:include | 31 | 6 | 0.0% |
| field:text | 19 | 4 | 0.0% |
| field:service_tier | 8 | 2 | 0.0% |
| field:parallel_tool_calls | 5 | 1 | 0.0% |
| field:store | 5 | 1 | 0.0% |
| field:stream | 4 | 1 | 0.0% |
| field:tool_choice | 4 | 1 | 0.0% |
| Tool definitions (0, 0 deferred) | 0 | 0 | 0.0% |

## before on the Mac

2026-11-11, the Mac, tree 2eb33144, Claude Code 2.1.312, codex-cli 0.164.0.

The Mac's Claude CLIs read `~/.claude/settings.json`, which sends them to the
Aliax shim and from there to the installed app, so the isolated instance's
gateway saw none of their requests and has no part table for them. The session
records give the totals: **Sonnet 159,445 and Opus 159,561 input tokens on a
200k window** (about 80%, as on the box). Cold Codex threads in the isolated
instance never reached a model: they reconnected on "workspace backend must use
an HTTPS origin without credentials" after unscoped discovery requests, so cases
(a) and (c) are unmeasured on the Mac. The warm case ran:

### codex gpt-6.1-sol (warm)

First request: 132,677 bytes, 27.9k input tokens of a 475.0k window (5.9%).

| Part | Bytes | ≈ tokens | Share |
|---|---:|---:|---:|
| Developer messages | 68,810 | 14.5k | 51.9% |
| Tools in code mode (additional_tools) | 49,545 | 10.4k | 37.3% |
| User messages (AGENTS.md, context, the message) | 12,603 | 2.6k | 9.5% |
| field:client_metadata | 1,379 | 290 | 1.0% |
| JSON framing and settings | 190 | 40 | 0.1% |
| field:reasoning | 38 | 8 | 0.0% |
| field:prompt_cache_key | 36 | 8 | 0.0% |
| field:include | 31 | 7 | 0.0% |
| field:text | 19 | 4 | 0.0% |
| field:service_tier | 8 | 2 | 0.0% |
| field:parallel_tool_calls | 5 | 1 | 0.0% |
| field:store | 5 | 1 | 0.0% |
| field:stream | 4 | 1 | 0.0% |
| field:tool_choice | 4 | 1 | 0.0% |
| Tool definitions (0, 0 deferred) | 0 | 0 | 0.0% |

Tool surface: code mode (additional_tools).

## Codex: the fallback first turn, reproduced or not

| Host | Case | First request window | Tool surface | Input tokens |
|---|---|---:|---|---:|
| box, 0.163.0 | (a) cold | 475,000 | code mode | 22.6k |
| box, 0.163.0 | (b) adopts a warm app-server | 475,000 | code mode | 22.7k |
| box, 0.163.0 | (c) scratch CODEX_HOME, no models cache | 475,000 | code mode | 21.8k |
| Mac, 0.164.0 | (a) cold | not measured: the HTTPS-origin error | | |
| Mac, 0.164.0 | (b) adopts a warm app-server | 475,000 | code mode | 27.9k |
| Mac, 0.164.0 | (c) scratch CODEX_HOME | not measured: the HTTPS-origin error | | |

No case gave 258,400. The sighting's first turn stays unexplained in detail;
what the runs add is that a cold Codex 0.164 start whose discovery requests go
unscoped can fail to reach its backend at all, which fits "the models fetch
failed" better than a race. The driver now holds the first turn until
`model/list` names the thread's model (250 ms steps, 10 s at most, a stalls.log
line at the cap) and logs a first turn that still reports the 258,400 window for
a listed model; the host's thrash guard catches a recurrence either way. Warm
adoption needs no models check: the warm case read the model's metadata on both
hosts.

## after on the box

2026-11-11, tempcode-box, tree 62ed51c34, 2.1.311 (Claude Code), codex-cli 0.163.0. One thread per model at low effort, its first request.

### claude claude-sonnet-5-5

First request: 124,491 bytes, 45.8k input tokens of a 200.0k window (22.9%).

| Part | Bytes | ≈ tokens | Share |
|---|---:|---:|---:|
| Tool definitions (27, 1 deferred) | 46,889 | 17.2k | 37.7% |
| Auto memory MEMORY.md | 18,401 | 6.8k | 14.8% |
| Other messages | 15,531 | 5.7k | 12.5% |
| System prompt | 14,947 | 5.5k | 12.0% |
| Project CLAUDE.md | 12,986 | 4.8k | 10.4% |
| User CLAUDE.md | 5,705 | 2.1k | 4.6% |
| The first message | 5,623 | 2.1k | 4.5% |
| Other system reminders (skills, deferred tools, context) | 2,962 | 1.1k | 2.4% |
| JSON framing and settings | 1,108 | 407 | 0.9% |
| field:metadata | 212 | 78 | 0.2% |
| field:context_management | 59 | 22 | 0.0% |
| field:thinking | 42 | 15 | 0.0% |
| field:output_config | 16 | 6 | 0.0% |
| field:max_tokens | 6 | 2 | 0.0% |
| field:stream | 4 | 1 | 0.0% |

Tools by group: builtin 28,313, mcp:app 10,618, mcp:orchestrator 7,958.

### claude claude-opus-5-5

First request: 124,803 bytes, 45.9k input tokens of a 200.0k window (22.9%).

| Part | Bytes | ≈ tokens | Share |
|---|---:|---:|---:|
| Tool definitions (27, 1 deferred) | 46,578 | 17.1k | 37.3% |
| Auto memory MEMORY.md | 18,401 | 6.8k | 14.7% |
| Other messages | 16,026 | 5.9k | 12.8% |
| System prompt | 14,947 | 5.5k | 12.0% |
| Project CLAUDE.md | 12,986 | 4.8k | 10.4% |
| The first message | 5,750 | 2.1k | 4.6% |
| User CLAUDE.md | 5,705 | 2.1k | 4.6% |
| Other system reminders (skills, deferred tools, context) | 2,962 | 1.1k | 2.4% |
| JSON framing and settings | 1,109 | 408 | 0.9% |
| field:metadata | 212 | 78 | 0.2% |
| field:context_management | 59 | 22 | 0.0% |
| field:thinking | 42 | 15 | 0.0% |
| field:output_config | 16 | 6 | 0.0% |
| field:max_tokens | 6 | 2 | 0.0% |
| field:stream | 4 | 1 | 0.0% |

Tools by group: builtin 28,002, mcp:app 10,618, mcp:orchestrator 7,958.

### codex gpt-6.1-sol

First request: 109,648 bytes, 22.7k input tokens of a 475.0k window (4.8%).

| Part | Bytes | ≈ tokens | Share |
|---|---:|---:|---:|
| Developer messages | 56,152 | 11.6k | 51.2% |
| Tools in code mode (additional_tools) | 39,527 | 8.2k | 36.0% |
| User messages (AGENTS.md, context, the message) | 12,163 | 2.5k | 11.1% |
| field:client_metadata | 1,466 | 304 | 1.3% |
| JSON framing and settings | 190 | 39 | 0.2% |
| field:reasoning | 38 | 8 | 0.0% |
| field:prompt_cache_key | 36 | 7 | 0.0% |
| field:include | 31 | 6 | 0.0% |
| field:text | 19 | 4 | 0.0% |
| field:service_tier | 8 | 2 | 0.0% |
| field:parallel_tool_calls | 5 | 1 | 0.0% |
| field:store | 5 | 1 | 0.0% |
| field:stream | 4 | 1 | 0.0% |
| field:tool_choice | 4 | 1 | 0.0% |
| Tool definitions (0, 0 deferred) | 0 | 0 | 0.0% |

Tool surface: code mode (additional_tools).

## What changed

| | before | after |
|---|---:|---:|
| Claude Sonnet 5.5, first request | 160.8k of 200k (80.4%) | 45.8k of 200k (22.9%) |
| Claude Opus 5.5, first request | 160.9k of 200k (80.5%) | 45.9k of 200k (22.9%) |
| Codex gpt-6.1-sol, first request | 22.6k of 475k (4.8%) | 22.7k of 475k (4.8%) |

The project CLAUDE.md went from 305,539 bytes (~116k tokens) to an index of
about 13 KB, which took a Claude thread's first request well under the 35% of
its window this work aimed for (a real thread also carries the skill listing,
about 14k tokens, which the isolated instance has none of: about 60k, 30%). The largest parts left are the tool
definitions (the CLI's own, the app server and the orchestrator) and the auto
memory index. Codex was already small on this host: its tools ride in code
mode once it has the model's metadata. The Mac's after-run was not made: its
isolated instance sees neither the Claude requests (they go through the Aliax
shim) nor a cold Codex start (see "before on the Mac").
