# The Linux agent host: headless mode on the box

- `TEMP_CODE_HEADLESS=1` (src/main/headless.ts) runs the main process with no
  window, menu, dock or updater; the server, gateway, fixed-port listener and
  html preview's hidden window run as usual. A Linux process with no display
  is headless on its own; `TEMP_CODE_HEADLESS=0` asks for a window there (a
  proof's desktop under xvfb-run, as scripts/e2e-launch-mirror.ts does; an
  agent shell on the box inherits the service's `=1`). The last window
  closing quits only after the first user window has opened
  (`quitsOnAllClosed`): the origin migration's hidden helper closes before
  openSavedWindows runs, and on Linux that once quit the app at boot. In that mode the local socket's port is published
  in `<userData>/server.json` and `scripts/box/tc-local.mjs` speaks to it as
  the implicit admin (`tc-local remote.pairings.create …` on the box).
- The box (`ssh box`, docs/box.md) runs temp-code from
  `/srv/agents/temp-code-builds/current`
  as `temp-code.service` (agents user, agents.slice, Xvfb, a private D-Bus),
  data in `/srv/agents/temp-code-data`, env in `/etc/temp-code.env`; the
  tunnel maps `tempcode.landonhale.com` to its 7677. Deploy a ref with
  `ssh box 'box-update master'` (clone + build → trial → snapshot → commit,
  with rollback on failure) or `ssh box 'box-update v1.0.N'` (the release's
  prebuilt `temp-code-out-1.0.N.tar.gz`, verified against its sha256, no
  build); on both, node_modules are hardlinked from the current build when
  bun.lock is unchanged and installed otherwise (`BOX_UPDATE_FRESH_MODULES=1`
  forces the install); the build's `build-manifest.json` and the deploy log
  say which path ran (scripts/box/box-update-lib.sh, docs/box.md "Build
  once"); stage 85 installs the launcher and its library without
  restarting. Proof from the Mac is `bun scripts/e2e-box-remote.ts`.
- Deploy drift: every host's hello (and `/api/hello` for a known caller)
  carries `build` (release.json `n`, `1.0.N`, the commit, the platform;
  src/main/buildInfo.ts: the box's `.git/HEAD`, a published Mac build's
  `tempcodeBuild.sha` from release-publish.sh's extraMetadata). The Mac's
  main process reads master's release.json raw from GitHub every 10 minutes
  and on window focus after 15 idle minutes (src/main/deployDrift.ts; a
  failure keeps the last value; `deploy.master` RPC + `deploy-master` push,
  local only; headless hosts never fetch). `useDeployDrift(environmentId)`
  in the renderer's lib/deployDrift.ts gives `{behind, deployedVersion,
  masterVersion}`; chrome/DeployDrift.tsx is the muted tabular `+N` at the
  end of the host's submenu trigger in the rail's Hosts row and on its
  header on Settings → Hosts,
  tooltip naming both versions and the deploy (box) or publish (Mac)
  command; nothing when current or unknown. docs/box.md "Knowing the box
  is behind". Every "ask the login shell" call goes
  through src/main/server/loginShell.ts (`$SHELL`, else zsh on macOS, bash
  elsewhere): never hardcode /bin/zsh. `-lc` skips .zshrc and .bashrc,
  so a job that runs a tool by name there (the publish scripts, a batch
  shell step, a dev server, a project build) wraps its command in
  `withToolPath`, which puts `~/.bun/bin`, `/opt/homebrew/bin` and
  `/usr/local/bin` (macOS) or `~/.bun/bin` and `~/.local/bin` (elsewhere)
  first when the PATH lacks them; a publish once died `command not found:
  bun` without it.
- Harness config (commands, agents, `~/.claude/hooks`, settings.json,
  plugins, Codex prompts, config and `~/.codex/hooks.json`, Muse settings and
  hooks, two keys of ~/.claude.json) is mirrored Mac → box by the Mac's main
  process over the peer link (`src/main/server/remote/harnessSync.ts`,
  `harness.*` RPCs, admin; paths translated through `pathMap.ts`, so Codex's
  `[hooks.state."<home>/.codex/hooks.json:…"]` trust rows name the box's
  copy). Skills are the skills store's, not harness sync's: the four skill
  rules retired (`RETIRED_ROOTS`), the sender walks them no more, the
  receiver forgets what it landed under them at start and at each manifest
  (the files stay on disk) and counts an older sender's skill entries in one
  line. A dir that is a symlink lands as a copied tree, and a Mach-O file
  never crosses. The Sync row's tooltip names only the sets still carried
  (`HARNESS_SET_LABELS`, src/shared/harnessSets.ts). The set with its labels
  (`HARNESS_SET` in `harnessSet.ts`), the exclusions and the status line
  (each set with its file count) are in docs/box.md "Harness config: synced
  from the Mac". Proof: `bun run script:e2e-harness-sync`.
- Mobbin MCP (`mobbin`, `https://api.mobbin.com/mcp`) is set up globally
  for Claude Code and Codex on the Mac and box. Harness sync carries the
  server entries; each CLI on each host keeps its own OAuth grant, outside
  provider account sync. All four loaded Mobbin's eight tools on
  2026-10-24. Sign-in and SSH callback steps: docs/box.md "Mobbin MCP:
  Claude Code and Codex on both hosts". New sessions load the server;
  existing sessions may need an MCP reconnect.
- Memory goes both ways (`src/main/server/remote/{memorySet,memoryMerge,
  memorySync}.ts`, `memory.*` RPCs, admin): Claude Code's per-project memory
  (`.claude/projects/<encoded cwd>/memory/`, the encoded dir translated
  through the path map), plans and `~/.claude/CLAUDE.md`, Codex's
  `~/.codex/memories/` and `AGENTS.md`; never transcripts, secrets or
  `.git`. The host holding the link drives (`memory.exchange` →
  `memory.files`), the other decides: newer mtime wins, a content digest
  makes a no-op free, both-changed keeps the loser beside the winner as
  `<name>.conflict-<host>-<time>.md` on both hosts, a project `MEMORY.md`
  is unioned, deletions travel as 30-day tombstones. Runs on link-up,
  every 5 minutes, after a thread goes idle on either host (the box nudges
  over the Mac's link) and from Sync now. Each paired host's Sync group on
  Settings → Hosts shows files and time for both legs, and This Mac's Sync
  group folds the conflict copies open under its Memory switch. docs/box.md "Memory: synced both ways"; proof is
  the memory step of `bun run script:e2e-harness-sync`.
- Attachments on a remote thread: a file from another host (or a big paste)
  is uploaded to the thread's host before the turn names it
  (`attachment.begin/chunk/commit`, src/shared/contract-attachments.ts) into
  `attachmentDir(session)` (src/main/server/attachmentDir.ts: project cwd's
  `.temp-code/attachments/<sid>/`, else the workspace's, else
  `<userData>/attachments/<sid>/`); the fence checks turn attachment paths.
  docs/box.md "Attachments on a remote thread". Proof:
  `bun run script:e2e-attachments`.
- One thread moves Mac ↔ box from the thread menu's "Move to <host>…" rows (the ⋯ menu and the chip's right-click): the Mac's
  own `session.move` (local) pushes over `session.import.*` or pulls over
  `session.export.*` (admin, on the peer link) in hash-chained parts; the
  receiver lands it remapped and hidden, the source keeps a tombstone only
  on the echoed digest, and a link-up settles a half-done move
  (`src/main/server/{sessionMove,remote/sessionMover}.ts`,
  `src/shared/contract-session-move.ts`). The branch travels with it
  (`src/main/server/sessionMoveBranch.ts`): before any part, the source
  pushes the thread's branch to origin (else bundles the commits the
  receiver lacks over the link) and sends its uncommitted changes as a
  patch; the receiver checks the branch out at the same commit in the
  project (source on it directly, project clean on its default branch) or
  in `<project>/.claude/worktrees/<branch>`, reuses a checkout that has it,
  applies the patch with `git apply --3way` and keeps one that fails at
  `<cwd>/.temp-code/moved-changes.patch` with a row on the thread; the
  source keeps everything. The confirm says what travels
  (`session.move.preview`). Checkpoints stay on the source. docs/box.md
  "Moving a thread between hosts"; proof `bun run script:e2e-session-move`.
- Opening a box file on the Mac: the diff panel's rows, a transcript path's
  menu and the file tree's menu (`⌥⏎`) say "Open on the Mac" for a path on
  another host and "Open in <editor>" locally. `src/main/editorLaunch.ts`
  launches IDEA (`--line N path`), VS Code (`-g path:N`) or Xcode
  (`xed -l N path`) per the `editor.command` setting (Settings → Editor →
  Open files in; Auto = first installed; Swift under `ios/` prefers Xcode when it
  is chosen or IDEA is absent). A remote path is translated through the
  harness sync's path map inverted (`src/shared/openOnMac.ts`, box
  `/srv/agents/work/<X>` ↔ Mac `~/IdeaProjects/<X>`), both hosts hash the
  file (`fs.digest`), and only an identical Mac copy opens in the editor;
  otherwise the host's version opens in the app read-only with "Mac copy
  differs: on branch X here" / "No Mac copy" and "Open the Mac copy anyway"
  (lib/openInEditor.ts, surfaces/FileNoteBar.tsx). Web mode and a headless
  host hide the items (`editor.config()` is null). docs/box.md "Opening a
  box file on the Mac".
- A path a box thread's transcript names opens FROM THE BOX. The host of a
  path is never read off the path alone: `hostForPath` (src/renderer/src/
  lib/pathHost.ts; `hostOfPath(path, threadHost)` in lib/tcserver/projects.ts)
  takes a catalog root as the answer, else the host of the thread that
  named the path (`useTranscriptHost` in the transcript's chips, markdown
  links, edit rows and right-click menu → `OpenFileOptions.environmentId`
  → `FilePaneTab.environmentId`, read by MediaGate, FileEditor, Monaco and
  the mtime watcher), else this machine. `fs.media` stamps its host on every
  URL (`&host=<id>`, media.ts `setMediaHost`) and the Mac's asset handler
  streams another host's token over the admin peer link with `media.read`
  (2 MiB ranges, ids only; src/main/assets.ts `serveRemoteMedia`). A file
  missing on the host reads "No such file on <host>." docs/box.md "A box
  thread's files and images open from the box"; proof
  `bun run script:e2e-remote-media`.
- The Mac bridge: a box thread whose `macBridge.thread.<id>` setting names
  the Mac reads, lists and fetches Mac files and runs Mac commands
  (`mac_*` tools) over a reverse RPC on the Mac's peer link
  (`remote/peerCalls.ts`: `peer.register`, `peer.call` push, `peer.reply`,
  `peer.chunk`). The Mac decides everything in `remote/macBridge.ts`: a
  per-host policy (off by default), shared folders, and a Mac-local prompt
  for any other path and every command (`macBridge.decide` is local-only;
  a key sees what runs through `macBridge.activity`, read, and stops a
  running or held call through `macBridge.stop`, operate; the prompts and
  every setting stay the Mac's).
  Codex calls carry a per-thread token (`macTools.ts`). A thread in full
  access on its box (permission `auto`) is never prompted: the box sends its
  permission with every call and the Mac treats every call the policy admits
  as remembered. A card (above the thread's composer, a sonner toast for a
  thread off screen) is only ever a decision: a call that runs is a row of
  the thread's Activity section and of the host's Mac bridge list on
  Settings → Hosts, each with Stop, never a card. The cards are capped
  (`queueOf` in the renderer's lib/macBridge.ts): one waiting card per host
  with "and N more". The server still marks a call admitted without a prompt
  `quiet` while its `macBridge.showRunning.<envId>` is off
  (`runPresentation`); the desktop no longer reads or sets it. The load guard
  (`remote/macLoadGuard.ts`) sits between the decision and the spawn of
  every command, job and computer session the bridge admits, never a read,
  listing, fetch or write: `macBridge.maxRunning.<envId>` (default 4) caps
  a host's concurrent commands, jobs and live computer sessions together,
  `macBridge.maxComputer.<envId>` (default 2) caps its computer sessions
  alone (a command behind a session that cap holds still starts when it
  fits), and the load watch
  (os.loadavg every 15 s) holds every new one while the one-minute load is
  over `macBridge.loadLimit` (default 2 × cores) until it is back under
  0.75 × the limit. A held call is `status: 'held'` with its `held` standing
  (reason, position, load, limit), a row with Stop in the host's running
  list and the thread's Mac approvals dialog ("Waiting for the Mac, load
  12.3 of 8, 3rd in line"), never a card, and waits only within the call's
  own deadline. `macBridge.maxThreads.<envId>` (default 2) caps the
  Mac-local threads a host starts here: `MacBridge.admitThread(envId)`
  (also `macBridge.admitThread`, local) is asked by crossHostThreads.ts
  before every `thread.start` and `thread.spawn`. On Settings → Hosts a
  host's Mac bridge group holds its policy (a Select), its running and held
  calls with Stop and its forwarded ports; its caps with the live counts,
  forwarding and the shared folders are in the
  host's Mac bridge settings dialog (surfaces/settings/hosts/
  MacBridgeHostDialog.tsx); This Mac's section has the load with its limit. docs/box.md "The Mac bridge: what a box thread may touch on the
  Mac"; proof `bun run script:e2e-mac-bridge`. Computer use is one more
  class of call, off by default per host (`macBridge.computer.<envId>`):
  "Computer use: the Mac's apps from any thread" below and docs/box.md
  "Computer use from a box thread".
- Thread resources: what a thread created (git worktrees, simulators, dev
  instances), on its own host or on the Mac through the bridge, is on the
  host's `thread_resources` table (src/main/server/threadResources.ts; the
  parsers in threadResourcesParse.ts record nothing a command did not
  demonstrably create: git's `Preparing worktree` line, simctl's UDID,
  `TEMP_CODE_USER_DATA`), filed under the top-level thread with the id of the
  host the resource lives on. The thread menu's "Resources…" is a removal
  form (a checkbox per row, Remove N; disabled when the thread has nothing
  but dev servers, which Activity and the dev servers pane hold); archiving a thread with rows asks "and remove N resources on
  the Mac" (on by default; `session.archive { removeResources }` through
  the renderer's `archiveThread()` in lib/threadResources.ts; the fleet's
  Archive done goes through `session.batch { cleanup }` and the registry's
  `resourceCleanup`, which is `resources.remove`). Removal runs on
  the owning host through the bridge's runner as the thread
  (threadResourcesRemove.ts: `git worktree remove --force`, `git branch -D`
  only with nothing ahead of the upstream, else the branch stays and the row
  says so; `simctl shutdown` + `delete`), an offline Mac leaves the row
  waiting until it re-registers. RPCs `resources.list/listAll/remove` take
  ids only. docs/box.md "Thread resources"; the e2e-mac-bridge proof covers
  a bridged worktree's record and removal.
- Dev servers on the box reach the Mac's browser over the Mac's peer link.
  A dev server a thread opens is a `port` row on the ledger (pid, the call
  that opened it, and `what`, the listening process in plain words from
  `listenerWords` in src/shared/devServerWords.ts, "Bun server" for `bun
  src/server.ts`, which the Dev servers pane titles it by; src/main/server/threadPorts.ts): the server's own
  "Local: http://localhost:5173" line with a listener behind it, a listener
  new under the harness tree (`ss`/`lsof` + `ps`) while a shell call runs,
  or the host-wide sweep (portSweep.ts: 3 s after a shell call settles and
  every 15 s while a harness runs, only listeners not yet decided) that
  credits a background shell's server, reparented to init, by ancestry, the
  `~t=` scope or CLAUDE_PID in its environment, the output file a call
  named, or the thread folder holding its cwd, and skips databases,
  infrastructure, proxies, MCP servers, test runs, the gate's workers and
  the repository's own proofs (`scripts/e2e-*`, `scripts/.out/*.mjs`, the
  electron-stub preload)
  (src/shared/devServerRules.ts, which threadPorts.ts and the renderer apply
  too) and ports bound before a thread worked there
  (`bun scripts/port-sweep-dry-run.ts` prints its verdicts live); a sweep
  every 10 s, armed at boot, ends a row the moment nothing listens or its
  process is gone (a listener under the thread's own harness is followed as
  a watcher's restart), one live row per port on a host, and removal
  SIGTERMs then SIGKILLs the pid. The box sends its live ports (the ledger's and the Dev
  Server button's runs) to every registered Mac (`push: 'ports'`,
  remote/portForward.ts); the Mac binds 127.0.0.1 on the same number, else
  the next free one above (its own dev instance keeps 5173), answers
  `ports.bound`, and carries each connection as `ports.open/data/close`
  frames (remote/macPorts.ts, portStreams.ts: in order, paused while the
  link holds 1 MiB or 32 frames are unanswered); the box dials its loopback
  only. "Dev server forwarding" per host in its Mac bridge settings dialog
  (`ports.forward.<envId>`, on by default). The thread hears where its dev server is: "Forwarded to
  http://localhost:5174 on the Mac (5173 is taken there)" with a Mac, "The
  dev server (bun run dev) is listening on http://localhost:5173" without
  one (`devServerLine`, portTail.ts), in the shell call's result (claude's
  PostToolUse hook; a backgrounded call's listener is looked for through
  the hook's wait, `POLL_MS`) or whispered as a `<dev-server>` line once
  the row lands (a row the grace-period poll or the host-wide sweep records
  reaches the tail through `recorded(ids)`); the call's transcript row ends with "Open on the
  Mac :5174", and the Activity section and the dev servers pane have Open
  and Stop. The bottom dock's
  Dev servers tab starts one (its starter, surfaces/DevStarter.tsx):
  the host detects targets, only what a person would pick
  (devTargets.ts: the root's dev script with the lockfile's runner, then
  each workspace app by name, one script each; Expo and Xcode/XcodeGen apps
  Mac-only; each with `what`, a few words from src/shared/devServerWords.ts)
  and runs one in its own process group (devRuns.ts, `devServer.*`,
  `dev-run` pushes, `devServer.runs` for every running run) on this Mac or
  the box's copy of the project, for the thread on screen
  (`devServer.start { sessionId }`, `DevRun.sessionId`). One dev server per
  thread: Run for a thread that has one says "This thread already runs a
  dev server." over Replace and Start another (`runChoice`; Replace stops the first), the
  host holds the rule too (`devServer.start` for a thread with a live run
  or `port` row answers `{ replace: true, existing }` unless the request
  says `another` or `replace`, which stops the old ones first), and a
  thread's shell opening a second hears the same from the host's dev-server
  line (portTail.ts `oneServerLine`; a port the shared rules say is not a
  dev server, such as the gate's workers, is never announced). What runs
  lives in that ONE tab of the bottom dock (surfaces/DevServersPane.tsx on
  chrome/DockFrame.tsx; rules `liveServers` and `serverGroups` in
  lib/devServers.ts, state lib/devPane.ts): every server live on a
  connected host now (a running run, or a ledger `port` row still listening
  that passes the shared rules; a port a run holds is listed once), under
  the thread it belongs to, in plain words ("Vite dev server") with its
  address (the row's Open control, or "Open on the Mac :5174" for a server
  on another host) and the word Stop (chrome/DevServerRow.tsx), its
  console the server's log alone under its command (a ledger row's label, else the background task that shares its call); a row leaves the moment its host
  drops it. The dock
  is bottom only and has one bar (chrome/DockBar.tsx: the project's
  terminals and the Dev servers tab as line tabs, New terminal, Hide dock); the
  tab shows only when a host can serve the project, a server runs or the
  pane is open. Closed by default and never opened on its own (the Dev
  server row of every thread menu toggles it, lib/threadMenu.ts with
  `useThreadDevServer` in chrome/useThreadMenu.tsx; the bar's tab and a Run
  open it);
  while open it takes the terminals' place at the dock's height.
  Dev server consoles are never terminal tabs; old saved `devLog` tabs are
  dropped on load. docs/box.md "Dev servers on the box"; proof `bun run script:e2e-port-forward` (seam
  `session.proofShellCall`, `TEMP_CODE_E2E_STATUS=1`). The subdomain proxy
  for the phone is not built yet.
- Tool processes are guarded (src/main/server/processGuard.ts; docs/box.md
  "Tool processes: a mark per call, an orphan sweep, a memory cap"): a
  claude thread in full access runs every Bash call with `TEMP_CODE_THREAD`
  and `TEMP_CODE_CALL` exported into its shell (the driver's PreToolUse
  hook, `wrapBashCommand`; the approval card and the Activity row show the
  command as written, through `unwrapBashCommand` in src/shared/bashMarks.ts
  with the two marks),
  and the host SIGTERMs then SIGKILLs what still carries the call's mark
  when the call ends (never a harness, a ledger pid or a backgrounded
  call); the wrapped command also renices its own shell to 10 and idle
  I/O (`NICE_PRELUDE`; a codex app-server starts under `nice -n 10`), so
  tool builds never starve the server; every 10 s an orphan sweep (one read of /proc on Linux, one `ps`
  through the exec broker elsewhere, shared with a call end inside 2 s)
  kills a process of this user with no
  parent left that carries a thread's mark (`TEMP_CODE_THREAD`, `~t=`,
  CLAUDE_PID) 60 s after it was orphaned, one log line each, but only
  this instance's: the claude harness's environment and every wrapped
  call carry `TEMP_CODE_INSTANCE` (`guardInstanceOf`: a hash of the
  userData dir and a nonce in the `guard.instanceNonce` setting), a
  process marked by another instance is left alone, and one with no
  instance mark is swept only by the instance on the prod data dir
  (`isProdData`: Electron's default userData, or the box's
  /srv/agents/temp-code-data), so a dev instance never touches the
  installed app's processes; and a call
  whose processes pass `tools.memoryCapMb` (8 GiB) is killed with its tool
  result saying so. A codex app-server carries `TEMP_CODE_THREAD` alone.
- Pause and Stop reach the Mac
  (`src/main/server/macPause.ts`, every mac.* call passes its gate): a
  thread pausing (subagents with it, by the parentId chain) has its calls
  out on the Mac cancelled with the tool result "cancelled: the thread was
  paused" and one `mac.cancel` per thread, which the Mac answers as its Stop
  button would (deny a waiting card, kill a running command, end the jobs);
  while paused, commands, jobs and writes are held on the box in order and
  sent on Continue, or refused with "refused: the thread is paused" once the
  caller's timeoutMs would have passed; reads go through marked `paused` and
  only where they need no prompt. The Mac lists held calls (`mac.held`) as
  `paused` rows without Stop, the box pushes `macBridge.held` so the paused
  strip says "and N Mac jobs with it". docs/box.md "The Mac
  bridge: what a box thread may touch on the Mac"; proof
  `bun run script:e2e-mac-bridge` (its pause step uses the proof seam
  `session.markStatus`, `TEMP_CODE_E2E_STATUS=1` on an isolated instance).
- Threads across hosts, both ways: `app_start_thread` and `spawn_agent`
  take `environmentId` (`mac` for the thread's Mac or the only host
  registered here, `box` for the only host linked from here, or a host id),
  and the thread runs on that host as one of its ordinary threads; its id
  comes back as `<envId>:<sessionId>` and every supervision tool routes by
  it, `list_agents` with `host`, `app_read_thread` with the files it left
  there (`src/main/server/crossHostAgents.ts` asking, `remote/
  crossHostThreads.ts` serving, both built on every host; `src/shared/
  contract-crosshost.ts`). One transport abstraction (`remote/hostLinks.ts`):
  a host registered here with the `threads` offer is called by `peer.call`
  (the box → the Mac), a host linked from here by the same `thread.*`
  methods as admin requests on its listener (the Mac → the box; the caller
  is the socket's registration); the reports back (`crossHost.settled`,
  `crossHost.landing`) take the same road the other way. Path translation
  runs the map in both directions (`hostPathFor`). Admission on a Mac is the
  Mac bridge's thread cap, on the box `crossHost.maxThreads.<envId>`
  (default 4). A dropped link answers `linkDown` with the last state, never
  a hang. docs/box.md "Threads across hosts"; proof
  `bun run script:e2e-cross-host-threads`.
- The relay: a phone or bot paired with the box reaches the Mac's threads
  through the box. `/ws?ticket=…&host=<envId>` is a second socket under the
  Mac's id: the box answers the hello (the Mac's `environmentId`, `via` the
  box, `presence` the Mac's row), runs its own gate, refuses a method outside
  `RELAY_METHODS` and answers the key's `remote.push.*` itself, and forwards
  the rest over the Mac's link as `relay.frame`; the Mac serves the lane with
  its own `attach()` on a `RelaySocket` and sends its frames back as
  `relay.frames` (src/shared/contract-relay.ts; box side remote/relay.ts,
  Mac side remote/relayServe.ts). The Mac reports its screen and power
  (src/main/presence.ts: powerMonitor, `ioreg` at boot) in `peer.register`,
  on every change and every minute (`peer.presence`); the box keeps the rows
  (`relay.hosts`), lists them in the hello (`hosts`) and `/api/hello`, and
  pushes `presence` on a change. A state that forbids a call answers one line
  (`relayRefusal`): `unavailable: the Mac is locked` (the screen method
  only), `… asleep`, `… unreachable since HH:MM`; a drop mid-request is
  `linkDown: …` and closes the lane 4010; an unregistered host is 503 at the
  upgrade. `/mcp` takes `host` and `env_…:id` sessions (docs/remote-mcp.md
  "Hosts"). A Mac with no delivery of its own sends its notices as
  `relay.notice`. Seams: `TEMP_CODE_PRESENCE`, `presence.set` under
  `TEMP_CODE_E2E_PRESENCE=1`, the iOS test server's four relayed hosts
  (remote/relayLoopback.ts, `POST /presence`). docs/box.md "The relay";
  proof `bun run script:e2e-mac-relay`.
- Devices on the Mac: Settings → Hosts, a Devices group in the Mac's own
  section, lists this Mac's simulators and iPhones with their state words, the
  booted ones' CPU, the thread that holds each (the `thread_resources`
  ledger by UDID, "—" without it), the Xcode in use and the load; Shutdown,
  Delete (confirm names the holder) and Open in Xcode act locally. The
  Mac's main process gathers only while a viewer is open (`host.devices.
  watch`, a push every 30 s, `unwatch` or the socket closing stops it); a
  box's /ui and the phone read the same methods, forwarded to the Mac as
  `host.*` peer calls under the `devices` offer (`src/main/server/devices/`,
  `src/shared/contract-hostdevices.ts`, `surfaces/settings/hosts/Devices.tsx`).
  docs/box.md "Devices on the Mac".
- A restart mid-turn: `resume_after_boot` is a live ledger (a row per
  thread on every running status in `SessionRegistry.append`, cleared when
  the turn settles), and the signal handlers and `before-quit` stamp the
  shutdown time on it (`recordForResume`) when they get to run (under the
  box's `dbus-run-session` Chromium often aborts on the D-Bus disconnect
  first); after the servers and gateway are up
  `BootResumer` (src/main/server/resumeAfterBoot.ts) boots each one on its
  transcript with a "The host restarted during your turn at <time>; continue
  where you left off." nudge, four at a time, children first, paused ones
  left paused, and pushes one `boot-resume` (count, boot time) that the rail
  says once per boot as a sonner toast, "N threads resumed after restart"
  (`useBootResumeToasts`, chrome/HostRows.tsx). A running row
  with no live harness for 20 s flips to the `stopped` status (liveness sweep
  `sweepLiveness`, `DriverHandle.alive`); the held row above the composer says
  "Stopped  the harness is gone" with Resume, and `session.resume` on it calls
  `registry.resumeStopped`, the one resume path for a dead harness. A
  harness that dies with no turn open is settled at once by the driver's
  word (`DriverCtx.harnessGone` → `registry.settleGoneHarness`, the one
  rule the sweep is the fallback for): a thread watching its own
  background work idles with its tasks gone, a master kept watching by its
  batch reads stopped with Resume, an idle row only loses the dead handle;
  no error row either way, since the "died mid-turn" words are true only
  for a turn that was running, which keeps the error path. The clock: a
  turn that starts from a watching, error or stopped row counts from its
  own start (`append` stamps `busySince` fresh; a retry that queues after a
  failure from its queueing), a stopped watcher freezes nothing, and only a
  turn that died mid-stream carries its elapsed through Resume
  (`resumeStopped` anchors `busySince` once, before the boot, and appends
  `starting` then `running`, both keeping it); the transcript's closing
  line of a turn resumed from its failure or Stop row states the resumed
  stretch, and one resumed from the host's `stopped` row (the harness gone
  under it) carries its span on, so the line and the strip agree
  (`resumeTurnClock`, the block's `stoppedTs`). The boot reset idles only waiting and watching rows now.
  docs/box.md "Surviving a restart"; proof `bun scripts/e2e-survive-restart.ts`.
- Backups: restic to R2 bucket `tempcode-backups`, repo `box` from
  `box-backup.timer` (SQLite snapshotted with VACUUM INTO, never the live
  files) and repo `mac` from the launchd agent `dev.landon.tempcode.backup`
  (scripts/mac/backup.sh). Secrets are Keychain items `tempcode-restic` and
  `tempcode-r2-backups`, never files in this repo. docs/box.md "Backups".
