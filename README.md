# temp-code

Desktop coding-agent interface (working name). A thin Electron/React client
over a heavy local Node server that drives official agent harnesses — Claude
(Agent SDK), Codex (`codex app-server`), Cursor (`cursor-agent`) — under the
user's own logins. Built around cross-provider orchestration.

## Install

Apple silicon Macs only (arm64; an Intel build is out of scope for now),
macOS 12 or newer.

- Download the latest build:
  https://github.com/LandonDev/temp-code/releases/latest/download/TempCode-arm64.dmg
- Open the dmg and drag TempCode to Applications. The app is signed and
  notarized, so it opens without a Gatekeeper warning.
- It updates itself from this repo's releases: an update shows up in the
  sidebar footer and under Settings → General; it downloads when you ask
  and installs on restart.

What it needs on the machine: the agent CLIs you want to drive (`claude`,
`codex`, `cursor-agent`) signed into your own accounts, `git`, and for the
Java editor a JDK 21 or newer (the Eclipse language server downloads on
first use). The Accounts and Stats pages come from Aliax and work on their
own; the Aliax app is optional and shares the same vault when installed.

## Architecture

```
Renderer (React, Tailwind v4, zustand)
    │  one typed WebSocket — request/response + per-session subscriptions
Server (in Electron main for now)
    ├─ SQLite (node:sqlite): session tree + append-only event log
    ├─ SessionRegistry: live driver handles, subscriptions
    └─ drivers: claude · codex (experimental) · cursor (experimental)
         each session = an official harness process, user's own auth
```

- `src/shared/` — catalog, normalized event schema, WS contract (both sides
  import these; nothing else crosses the wire).
- `src/main/server/` — server, store, drivers.
- `src/renderer/` — app shell. UI system: ReUI (base, `components/ui` +
  `components/reui`), BeUI motion (`components/motion`), Beautiful UI
  agent primitives (`components/bui`, copy-paste + adapt).

Plan: `docs/PLAN.md`.

## Develop

```bash
bun install
bun run dev        # from a Claude Code shell: env -u ELECTRON_RUN_AS_NODE bun run dev
```

Live end-to-end tests (real harnesses, run outside Electron):

```bash
bun run script:e2e-claude          # driver mapping, tools, interrupt, resume
bun run script:e2e-lifecycle       # archive/restart/delete (no LLM calls)
bun run script:e2e-approval        # canUseTool → allow + deny paths
bun run script:e2e-providers       # claude + codex + cursor side by side
bun run script:e2e-orchestration   # orchestrator spawns a codex subagent
```

`REUI_LICENSE_KEY` in `.env.local` (git-ignored) unlocks ReUI Pro installs:
`bunx --bun shadcn@latest add @reui/<name> --yes`. BeUI: `@beui/<name>`.
