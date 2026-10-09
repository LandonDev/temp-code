# TempCode

[![Download for Mac (Apple silicon)](https://img.shields.io/badge/Download%20for%20Mac-Apple%20silicon-0A84FF?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/LandonDev/temp-code/releases/latest/download/TempCode-arm64.dmg)
[![All releases](https://img.shields.io/github/v/release/LandonDev/temp-code?style=for-the-badge&label=Releases&color=555)](https://github.com/LandonDev/temp-code/releases)

TempCode is a Mac desktop app for working with coding agents. It runs the
official agent CLIs under your own logins and gives them one workspace:
projects, threads, a code editor, terminals, git, and an inbox.

- **Providers.** Claude (Agent SDK), Codex (`codex app-server`) and Cursor
  (`cursor-agent`), each thread a real harness process on your own account.
  Grok Build, OpenCode, Pi, omp and fx run as experimental drivers.
- **Threads.** Chat, planning, implementation, orchestration and research
  threads per project. An orchestration thread spawns subagents on any
  provider and watches them in a fleet panel.
- **Workspace.** File editor with TypeScript and Java language servers,
  terminals, git changes and branches, a GitHub and Linear inbox, notes and
  search across every thread.
- **Accounts.** The Aliax Accounts and Stats pages are built in: capture
  accounts, switch between them, and see usage over time.

## Install

Apple silicon Mac on macOS 12 or newer. Download the dmg above, open it,
and drag TempCode to Applications. The app is signed and notarized.

It needs on the machine:

- The agent CLIs you want to drive, signed in: `claude`, `codex`,
  `cursor-agent`.
- `git`.
- A JDK 21 or newer for the Java editor. The Eclipse language server
  downloads on first use.

The app updates itself from this repo's releases. It checks at launch and
every half hour, downloads when you ask, and installs on restart.

## How it is built

```
Renderer (React, Tailwind, one typed WebSocket)
    │
Server in the Electron main process
    ├─ SQLite: project and thread tree, append-only event log
    ├─ drivers: claude · codex · cursor · grok · opencode · pi · omp · fx
    └─ editor, terminal, git, GitHub, Linear and Aliax services
```

- `src/shared/` holds the model catalog, the event schema and the wire
  contract. Both sides import it and nothing else crosses the socket.
- `src/main/` is the Electron main process: the server, the drivers, the
  updater and the Aliax bridge.
- `src/renderer/` is the app shell.

## Develop

```bash
bun install
bun run dev          # from an agent shell: env -u ELECTRON_RUN_AS_NODE bun run dev
bun run test         # vitest
bun run typecheck
bun run build        # typecheck + electron-vite build
```

Releases are arm64 only. `bun run release:publish` signs, notarizes and
publishes the current version to GitHub releases; see CLAUDE.md for the
release train.
