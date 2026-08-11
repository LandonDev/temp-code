# temp-code

Desktop coding-agent interface (working name). A thin Electron/React client
over a heavy local Node server that drives official agent harnesses — Claude
(Agent SDK), Codex (`codex app-server`), Cursor (`cursor-agent`) — under the
user's own logins. Built around cross-provider orchestration.

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

`REUI_LICENSE_KEY` in `.env.local` (git-ignored) unlocks ReUI Pro installs:
`bunx --bun shadcn@latest add @reui/<name> --yes`. BeUI: `@beui/<name>`.
