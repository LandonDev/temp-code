# temp-code — instructions for AI sessions

## One line: prod runs the newest published GitHub release
- `/Applications/TempCode.app` runs the newest `v1.0.N` release on
  github.com/LandonDev/temp-code (public). It updates itself through
  electron-updater: at launch, every 30 minutes, and when a window comes
  forward after 15 idle minutes it reads the feed's latest-mac.yml, offers
  the release, downloads only when asked, and restarts on request. Its data
  lives in `~/Library/Application Support/TempCode/` (`dev:prod` still runs
  on the older `temp-code/` dir).
- Nothing reaches users until `bun run release:publish` runs (see below).
  Every green commit on master is still tagged locally, so commit only
  finished, verified slices: the next publish ships everything since.
- `stable` is a pointer the updater no longer reads; it is moved onto
  master at each cutover (`git branch -f stable master`) and otherwise
  left alone. The pre-MonoCode line (v96) lives on in the reflog only.

## The user lives in the installed app — never touch it
Do not launch anything against the prod userData (that means never
`bun run dev` without TEMP_CODE_USER_DATA, and never `bun run dev:prod`
from an AI session), do not send messages into the user's threads, and
do not kill or restart the installed app.

## Testing: spawn an isolated dev instance
```bash
env -u ELECTRON_RUN_AS_NODE \
  TEMP_CODE_USER_DATA="$HOME/Library/Application Support/temp-code-dev" \
  TEMP_CODE_DEBUG_PORT=9224 bun run dev
```
- Own database, own window; CDP on 9224 for driving and screenshots
  (`window.__app` exposes the store in dev builds).
- These are ENFORCED in code: a dev build without TEMP_CODE_USER_DATA
  exits immediately (it would open the installed app's database — a
  second SQLite writer there freezes the user's live threads), and each
  userData dir takes a single-instance lock. If several sessions test at
  once, each needs its OWN userData dir and debug port (temp-code-dev2 /
  9226, …).
- `env -u ELECTRON_RUN_AS_NODE` is required — the variable leaks into
  agent shells and breaks Electron.
- Renderer must be on port 5173; a different port means a stale dev
  server from another session is holding it. Kill it (`pkill -f
  electron-vite`) and relaunch — electron-vite never restarts the main
  process on its own, so main-process changes always need a relaunch.
- Kill your dev instance when the pass is done.
- Updater end to end: `bun run script:e2e-updater` (scripts/e2e-updater.ts)
  builds two signed, un-notarized copies of the tree (1.0.N-1 and 1.0.N) with
  their own bundle id and product name, serves the newer one from a local
  feed, and drives the older copy under /private/tmp/tc-updater-e2e through
  check → download → restart over CDP (port 9230) until the bundle on disk
  is 1.0.N and the relaunched app answers. The hooks it uses:
  `TEMP_CODE_UPDATE_FEED=<url>` makes a packaged copy that also has
  `TEMP_CODE_USER_DATA` read a generic feed (latest-mac.yml + zip) at that
  URL, with its downloads under `~/Library/Caches/temp-code-harness-updater`;
  and a `tempcodeHarness` block in the bundled package.json (electron-builder
  extraMetadata) carries the same three TEMP_CODE_* keys into an app that
  Squirrel's ShipIt relaunches without our environment (src/main/harness.ts).
  Its Squirrel state lives in `~/Library/Caches/dev.landon.tempcode.e2e.ShipIt`.
  Nothing of this touches /Applications/TempCode.app or its caches.

## The user dogfoods master on the prod data
`bun run dev:prod` runs master against the prod userData (CDP on 9220).
It is the user's command, not ours. The single-instance lock keeps it and
the installed app from running at once: quit one before opening the
other. Master only adds to the database (new tables, defaulted columns),
so the two apps can take turns on it. Unread marks and layout live in
localStorage, which differs by origin, so they do not carry across.

## Releases: the local train tags, `release:publish` ships
Two separate steps, on purpose.

1. **Every green commit tags locally.** A post-commit hook on master
   (.githooks/, wired via core.hooksPath) runs `bun scripts/release.ts`
   after every commit: it gates on a clean tree + typecheck + tests +
   build, bumps release.json to N and package.json to `1.0.N`, commits
   both, and tags `release-N`, using your commit subject as the release
   notes. That is bookkeeping: no user sees it.
   - If the hook skipped (tree was dirty at commit time, or the gate was
     red), the next green commit releases everything since; you can also
     run `bun scripts/release.ts "notes"` yourself.
   - Worker log: /tmp/temp-code-auto-release.log.
   - Never commit with a broken typecheck "to fix later" — that blocks the
     train.
   - Commit messages carry no `Co-Authored-By` or other AI attribution
     trailers: GitHub renders them as a second contributor on every commit.
     `.claude/settings.json` turns the trailer off; do not add one by hand.
2. **`bun run release:publish` publishes HEAD's 1.0.N** (scripts/
   release-publish.sh, the same shape as Aliax's release): clean tree on
   master, signs with the Developer ID Application identity in the login
   Keychain, notarizes through the `aliax` notarytool Keychain profile,
   uploads the arm64 zip + dmg + latest-mac.yml to the GitHub release
   `v1.0.N`, writes the notes from the commits since the last `v1.0.*`
   tag, verifies the feed, and pushes the `v1.0.N` tag. It refuses a
   version the feed already serves. Apple silicon only; Intel is out of
   scope for now.

Never build into or swap /Applications/TempCode.app yourself: the installed
app replaces itself from the feed, and only from the feed.

## Launch-time code caches: boot.js, the compile cache, the app scheme
- `package.json` `main` is `out/main/boot.js` (src/main/boot.ts), a second
  main entry that in a packaged app enables Node's compile cache at
  `$TMPDIR/temp-code/compile-cache` (macOS purges it after three idle days)
  and then requires `out/main/index.js` through it; index.ts flushes the
  cache 10 s after boot and in `before-quit`, because Electron's quit never
  reaches Node's exit-time write. `TEMP_CODE_COMPILE_CACHE` points an
  isolated copy elsewhere. The first `[boot]` line of a launch reads
  `index <ms> start=<epoch> compile-cache=on|off`; dev runs say `off`.
- The packaged renderer loads from `tempcode-app://renderer/index.html`
  (src/main/appScheme.ts), a privileged scheme with `codeCache: true`, so
  Chromium keeps a V8 code cache for the 8 MB index bundle; `file://` never
  gets one. Both schemes register in one `registerSchemes()` call
  (assets.ts). First boot on the new origin copies the `file://`
  localStorage over once (src/main/originMigration.ts, marker
  `<userData>/localstorage-migrated`).
- Proof: `bun run script:e2e-launch-timing` (scripts/e2e-launch-timing.ts)
  packs an isolated copy under /private/tmp/tc-launch-timing and launches it
  four times with Chromium's startup trace on; the report shows the `index`
  mark, `tc:ready`, and the index bundle's `consumedCacheSize`.

## Provider traffic: the gateway, and Codex needs 0.162.1+
Every Claude and Codex child sends its API traffic to a loopback gateway
(src/main/server/gateway.ts) that swaps in the account the thread is
routed to (aliax-core's `forward`). Two listeners:
- **One plain-http port** is the marker's `url`. Aliax's shim (8787, TLS on
  8789) forwards terminal traffic here when we own the marker, and Claude
  children carry their `~t=<thread>;a=<account>[;pin=1]` scope on this
  port's path (endpoint.ts `routeUrl`), after a `scoped-routes` feature
  probe of whoever answers.
- **One https port per codex thread.** Codex 0.158+ refuses an http
  `chatgpt_base_url` and keeps only the ORIGIN of an https one for the
  sampling call (`<origin>/backend-api/codex/responses`), so a path scope is
  lost. Instead `routedEndpointFor('codex')` asks the gateway for a port of
  the thread's own (`scopedCodexUrl`); the listener rewrites `/backend-api/*`
  and `/codex/*` into the scoped path core parses (`scopedCodexPath`) and
  refuses WebSocket upgrades so codex drops to its HTTP stream at once.
  Codex children never use the shim. The certificate is Aliax's pair in
  ~/.aliax/tls when present, else an app-owned CA + leaf under
  `<userData>/tls` (src/main/server/tls.ts); children trust it through
  `CODEX_CA_CERTIFICATE` (harnessEnv), so no Keychain step is needed.
  `TEMP_CODE_GATEWAY_TRACE=1` logs one line per forwarded request.
- The installed codex version is read once at boot (drivers/codexVersion.ts)
  and catalog rows with `minCodexVersion` above it are hidden everywhere
  (picker, spawn table, app tools). GPT-6.1 Sol and GPT-6 Sol need 0.162.1.
- A dev instance is not the marker owner, so core does not refresh codex
  tokens there: an account whose stored token lapsed answers 401
  ("token_expired") until the owner uses it. Pin test threads to an account
  the installed app uses, or expect that failure.
- Accounts across hosts (thread V): every profile in Aliax's `profiles.json`
  has an owner environment (absent = this machine) and only the owner ever
  presents a refresh token; other hosts hold access-only copies kept fresh
  over the main process's own peer links (`src/main/server/remote/peers.ts`,
  `accountSync.ts`; RPCs `accounts.push`/`accounts.pull`, admin only). A
  Claude "one-year token" is a static profile every host holds, with no
  owner: what `claude setup-token` makes, minted in-app (T1; aliax-core
  `src/mint.ts`, `src/main/aliax/{staticMint,staticTokens}.ts`) by adding
  `expires_in: 31536000` to the ordinary code exchange or to a refresh_token
  grant; the token response names its account and a token is filed only
  under that account. "Convert all to one-year tokens" on the Claude panel
  converts every account; a grant another host refreshes (the box, from an
  earlier handoff) is taken back first over the peer link (`AccountSync.
  takeBack`: the takeOver pull `accounts.setHome` uses, provisional
  landing, `accounts.confirm`, the owner strips) and minted from here, a
  host out of reach leaves the session and the sign-in window to mint, and
  the row names that host when those fail too (never "convert it there");
  tokens inside their last 30 days renew on their
  own through the stored claude.ai session (6 h cadence, row + footer say
  "Sign in to renew" when the session is gone); the box's live sign-in is
  the first static token it got and follows that account's renewals; the
  host that mints a token for the account its CLI is signed in with
  installs that token as its live sign-in (the refresh route rotates the
  grant the CLI holds), and a lapsed live sign-in whose account holds a
  static token is repaired at boot and every six hours
  (`StaticTokens.repairLive`). Sign
  in on the Mac; the box never does (docs/box.md "Accounts: sign in on the
  Mac once"). A handoff is
  two-phase under aliax-core's per-profile lock (`src/lock.ts`, shared with
  the token refresh): the receiver saves provisionally and echoes a digest
  of the refresh token, the sender strips only on that echo, then
  `accounts.released` makes the receiver the owner; a takeOver pull holds
  the grant out until `accounts.confirm` (30 s, else the owner keeps it);
  the next sync settles anything a lost message left half done. A peer's
  pushes and pull answers land only on accounts already on file here
  (`applyTransfer(..., 'peer')`); a grant the local CLI is signed in with
  (Claude's Keychain item, Codex's auth.json) is never handed off. Test
  seams for isolated instances: `TEMP_CODE_ALIAX_DATA_DIR` (own vault,
  key-file mode), `TEMP_CODE_FAKE_PROVIDERS=<origin>` (every provider call
  goes there), `TEMP_CODE_GATEWAY_ROLE=owner` (refresh without the marker),
  `TEMP_CODE_DROP_ANSWERS=method:count` (swallow answers, for a dropped
  response), `CODEX_HOME` (the adapter's auth.json), `ALIAX_CREDENTIAL_BACKEND=file`
  + `CLAUDE_CONFIG_DIR` (the Claude CLI's credentials in a file inside the
  instance's data, never the Keychain), `TEMP_CODE_STATIC_RENEW_FIRST_MS` /
  `_EVERY_MS` (the renewal cadence); proofs are `bun run script:e2e-accounts-sync`
  and `bun run script:e2e-static-tokens`.

## Remote access: the fixed port behind the tunnel
- A second listener (src/main/server/remote/listener.ts) binds
  `127.0.0.1:7677` by default; the Cloudflare tunnel on the box maps
  `tempcode.landonhale.com` to it, TLS ends at Cloudflare, and
  `CF-Connecting-IP` / `X-Forwarded-Proto` are believed only from a loopback
  socket. The renderer's random-port loopback socket is unchanged and stays
  implicitly admin.
- `TEMP_CODE_REMOTE_PORT=<n>` overrides the port for a dev instance (so it
  never fights the installed app for 7677); `0` turns the listener off. The
  settings `remote.enabled`, `remote.port`, `remote.publicOrigin` live in the
  settings table and the Settings → Remote access pane edits them. A port in
  use logs one `[remote]` line and leaves remote off; `remote.status` carries
  the error. `TEMP_CODE_REMOTE_TRACE=1` logs one line per request.
- Identity: `<userData>/environment.json` holds `env_<22 chars>`, created
  once and never copied with the database. Every socket's first frame is
  `{ push: 'hello', environmentId, contract, caps, key? }`.
- Keys (remote/auth.ts): `tc_<id>.<secret>`, scrypt at rest, each with an
  audience (`client` for phones, browsers and desktops on `/ws` and `/api/*`;
  `mcp` for bots on `/mcp`, capped at read,operate) and a capability set from
  read | operate | approve | admin. Every RPC has a row in
  src/shared/capabilities.ts (`local` rows, every `app.*`, lsp, dap, idea,
  providers.update, fim and stall.report, never run for a remote caller);
  `session.create` with `permission: 'auto'` and `session.permission` need
  approve. The gate runs in `attach()` before any handler.
- The path fence (remote/fence.ts, R2 H1/H2): for every remote principal,
  each method that names a path or cwd (`fs.*`, `git.*`, `github.*`,
  `search.project`, `workspace.create`, `session.create`'s cwd, logo and
  command-list paths) must point, by real path, under a project cwd, a
  workspace path or the configured/box work root (never the bare home
  directory); the refusal is `forbidden: <method> is outside app-managed
  roots` and never logs the path. The loopback socket is unfenced. Nothing
  was demoted to `local`: the /ui bundle and the desktop's remote-host
  flows call the whole donor family, and the phone calls `fs.readPreview`,
  `search.project` and `github.*`. `fence.test.ts` asserts every
  path-taking contract method has a row.
- Pairing: an admin makes a code (`XXXXX-XXXXX`, 10 minutes, single use) in
  the pane or over `POST /api/pairings`; the link is `<origin>/pair#<code>`.
  Redemption claims the row in one conditional UPDATE before minting, so
  concurrent redeems answer one key (R2 M1). The link's origin is learned
  only from an admin's own authenticated request, never from the Host of an
  anonymous loopback request (L1); `/api/hello` without a key answers only
  the environment id and contract (L2); the `/pair` page's script runs under
  a per-response nonce, no `'unsafe-inline'` for scripts (L3).
  `POST /api/pair` with `kind: 'key'` answers the raw key once; with
  `kind: 'session'` it sets the HttpOnly `tc_session` cookie that `/ui` and
  cookie upgrades of `/ws` use. Bearer clients mint a 30 s ticket at
  `POST /api/ticket` and upgrade `/ws?ticket=…`; nothing else ever rides in
  a socket URL. Revoking a key closes its sockets and sessions at once.
- `/ui` serves the BUILT renderer (out/renderer, so `electron-vite build`
  first in a dev tree) behind the cookie; the bundle detects a missing
  `window.api` and runs in web mode (src/renderer/src/lib/nativeWeb.ts: no
  terminal, no Aliax pages, its own `web` workspace slot). `/asset/<host>/…`
  mirrors `tempcode-asset://` for logos, media and agent pages.
- Webhook targets (remote/addressGuard.ts, R2 M3): a key's webhook URL and
  a hub subscription URL must be https to a public host; loopback, RFC 1918,
  CGNAT, link-local (169.254.169.254), v6 unique-local/link-local, `.internal`,
  `.local` and bare names are refused when made, the host is resolved then,
  and each delivery pins the socket's lookup to re-checked addresses (the hub
  resolves over DNS-over-HTTPS before every POST). `TEMP_CODE_WEBHOOK_ALLOW_LOOPBACK=1`
  admits a 127.0.0.1 receiver for a proof script; nothing else private, ever.
- Proof: `bun run script:e2e-remote` (the bearer flow against a temp
  server), `bun run script:e2e-remote-fence` (in the release gate: the fence
  for a read and an operate key on every path-taking method, the concurrent
  pairing redeem, refused webhook targets, the learned origin, the anonymous
  hello and the pair page CSP) and `bun scripts/e2e-remote-ui.ts` (an
  isolated preview instance plus a real Chrome profile over CDP through
  `/pair`, `/ui`, a thread, a reply, the cookie and the CSP rewrite).

## The Linux agent host: headless mode on the box
- `TEMP_CODE_HEADLESS=1` (src/main/headless.ts) runs the main process with no
  window, menu, dock or updater; the server, gateway, fixed-port listener and
  html preview's hidden window run as usual. A Linux process with no display
  is headless on its own. In that mode the local socket's port is published
  in `<userData>/server.json` and `scripts/box/tc-local.mjs` speaks to it as
  the implicit admin (`tc-local remote.pairings.create …` on the box).
- The box (`ssh box`, docs/box.md) runs temp-code from
  `/srv/agents/temp-code-builds/current`
  as `temp-code.service` (agents user, agents.slice, Xvfb, a private D-Bus),
  data in `/srv/agents/temp-code-data`, env in `/etc/temp-code.env`; the
  tunnel maps `tempcode.landonhale.com` to its 7677. Deploy a ref with
  `ssh box 'box-update master'` (build → trial → snapshot → commit, with
  rollback on failure); stage 85 installs the launcher without restarting. Proof from the Mac is
  `bun scripts/e2e-box-remote.ts`. Every "ask the login shell" call goes
  through src/main/server/loginShell.ts (`$SHELL`, else zsh on macOS, bash
  elsewhere): never hardcode /bin/zsh.
- Harness config (skills, commands, agents, settings.json, plugins, Codex
  config, two keys of ~/.claude.json) is mirrored Mac → box by the Mac's main
  process over the peer link (`src/main/server/remote/harnessSync.ts`,
  `harness.*` RPCs, admin; paths translated through `pathMap.ts`); the set,
  the exclusions and the status line are in docs/box.md "Harness config:
  synced from the Mac". Proof: `bun run script:e2e-harness-sync`.
- Attachments on a remote thread: a file from another host (or a big paste)
  is uploaded to the thread's host before the turn names it
  (`attachment.begin/chunk/commit`, src/shared/contract-attachments.ts) into
  `attachmentDir(session)` (src/main/server/attachmentDir.ts: project cwd's
  `.temp-code/attachments/<sid>/`, else the workspace's, else
  `<userData>/attachments/<sid>/`); the fence checks turn attachment paths.
  docs/box.md "Attachments on a remote thread". Proof:
  `bun run script:e2e-attachments`.
- One thread moves Mac ↔ box from the thread header's host chip: the Mac's
  own `session.move` (local) pushes over `session.import.*` or pulls over
  `session.export.*` (admin, on the peer link) in hash-chained parts; the
  receiver lands it remapped and hidden, the source keeps a tombstone only
  on the echoed digest, and a link-up settles a half-done move
  (`src/main/server/{sessionMove,remote/sessionMover}.ts`,
  `src/shared/contract-session-move.ts`). Checkpoints and uncommitted changes
  stay on the source. docs/box.md "Moving a thread between hosts"; proof
  `bun run script:e2e-session-move`.
- The Mac bridge: a box thread whose `macBridge.thread.<id>` setting names
  the Mac reads, lists and fetches Mac files and runs Mac commands
  (`mac_*` tools) over a reverse RPC on the Mac's peer link
  (`remote/peerCalls.ts`: `peer.register`, `peer.call` push, `peer.reply`,
  `peer.chunk`). The Mac decides everything in `remote/macBridge.ts`: a
  per-host policy (off by default), shared folders, and a Mac-local prompt
  for any other path and every command (`macBridge.decide` is local-only).
  Codex calls carry a per-thread token (`macTools.ts`). A thread in full
  access on its box (permission `auto`) is never prompted: the box sends its
  permission with every call and the Mac treats every call the policy admits
  as remembered. A command admitted without a prompt (remembered, or such a
  thread) shows on the Mac as a running card only while the host's "Show
  running commands" (`macBridge.showRunning.<envId>`, off by default under
  `full`, on otherwise) is on; otherwise the request is `quiet`
  (`runPresentation`): no card, listed with Stop under the host's row in
  Settings → Remote access. The cards are capped (`queueOf` in the renderer's
  lib/macBridge.ts): one waiting card per host with "and N more", the running
  ones one line per host with Stop all. docs/box.md "The Mac
  bridge: what a box thread may touch on the Mac"; proof
  `bun run script:e2e-mac-bridge`.
- Threads on the Mac from the box: `app_start_thread` and `spawn_agent`
  take `environmentId` (`mac`, or a host id), and the thread runs on that
  Mac as an ordinary This Mac thread; its id comes back as `<envId>:
  <sessionId>` and every supervision tool routes by it (`src/main/server/
  crossHostAgents.ts` on the box, `remote/crossHostThreads.ts` on the Mac,
  `src/shared/contract-crosshost.ts`; the `threads` peer offer rides the
  Mac bridge's `peer.call`, `thread.*` methods, `crossHost.settled` back).
  Which Mac: the thread's `macBridge.thread` peer, else the only one
  registered. A dropped link answers `linkDown` with the last state, never
  a hang. docs/box.md "Starting a thread on the Mac from the box"; proof
  `bun run script:e2e-cross-host-threads`.
- Backups: restic to R2 bucket `tempcode-backups`, repo `box` from
  `box-backup.timer` (SQLite snapshotted with VACUUM INTO, never the live
  files) and repo `mac` from the launchd agent `dev.landon.tempcode.backup`
  (scripts/mac/backup.sh). Secrets are Keychain items `tempcode-restic` and
  `tempcode-r2-backups`, never files in this repo. docs/box.md "Backups".

## The iOS contract package is generated
- `ios/TempCodeContract` holds the Swift `Codable` types of the remote wire,
  generated from zod by `scripts/gen-swift-contract.ts` (`bun run gen:swift`).
  `src/shared/wireSchemas.ts` is the zod for every server → client shape,
  pinned to its interface by type-level checks that the typecheck runs; the
  generator's `SUBSET` array is the one list of what the phone speaks.
- Never edit `Sources/TempCodeContract/Generated/`. Change the contract,
  run `bun run gen:swift`, commit the output: `bun run check:swift-contract`
  (inside `bun run typecheck`) fails the gate when it is stale, and
  `bun run ios:test` (in the gate too) builds and tests the package.
  Fixtures under `Tests/Fixtures` come from a real server through
  `bun run script:capture-swift-fixtures`; re-record them when a captured
  shape changes. The package README has the subset policy and what L2
  (the socket actor) builds on it.

## The iOS client: ios/TempCodeClient and ios/TempCode
- docs/IOS-DESIGN.md fixes the phone's design: information architecture
  (Home with Needs you, Running, Workspaces; Inbox; Search), the thread
  screen per type (board, plan, fleet, sources as the hero with the chat as
  a second segment), tokens, exact motion values and the performance rules.
  iOS threads build to it and do not re-decide what it states.
- `ios/TempCodeClient` (Swift 6 package on the contract package) is the
  phone's connection runtime: `TempCodeSocket` mirrors the desktop supervisor
  (ticket, hello checked against the paired id and contract, jittered backoff
  to 5 min reset after 30 s up, probes on foreground/online/retry, a 10 s
  background grace), `Subscriptions` resumes with `afterSeq` and honours
  `reset`, `SessionCache` is the sqlite3 mirror a cold launch paints from,
  `EnvironmentClient` is what SwiftUI observes. Its README has the state
  table and the L3/L4 extension points. `ios/TempCode` is the read-only
  SwiftUI app, generated by `xcodegen` from `project.yml`.
- The thread screens (L4) live in `ios/TempCode/Sources/Thread/`; the entry
  the shell routes to is `ThreadScreen(client:sessionId:targetSeq:)`, one
  screen for every type and for a subagent's detail. The models they read
  are the client package's `Rendering/`: `ThreadFold` (the desktop's fold
  with round, todo and pass stamps and the `BoardState` of todos.ts), the
  `Board`, `ResearchBoard`, `Fleet` and `PlanDoc` selectors, and the
  `MarkdownCache` that parses rows off the main actor; `threads[id].fold`
  stays current incrementally. The plan or report file is read with
  `file.read` (in the subset since L4), polled 1.5 s running / 8 s idle
  while the screen shows. DEBUG launch hooks (`TC_TEST_SEGMENT`,
  `TC_TEST_OPEN=chip|diff|agent`, `TC_TEST_SCROLL=1`, and L5's
  `TC_TEST_ACTION=send:<text>|stop|approve|deny|answer:<label>|start-build|
  rename:<title>|pin|archive|new-chat` and `TC_TEST_SHEET=start|new`) exist
  for the proof only; an action runs once, on the screen the launch route
  opened, through the same calls the buttons make.
- Steering (L5): `ios/TempCode/Sources/Thread/Composer.swift` (the bar on
  every segment, Send ↔ Stop) and `WorkingStrip.swift` (the fixed 28 pt
  row: Sending…, spinner + flavour word + elapsed, the paused row with Stop
  and Continue); live approval and question cards in `TranscriptRows.swift`;
  `Shell/ThreadSheets.swift` (Start a build from a plan, New thread from a
  workspace or project header's `+`, both over the host's `catalog.get`);
  `Design/ThreadRowActions.swift` (swipe to pin and archive, context menu
  with rename). All of it sits on the client package's `Client/Actions.swift`
  (the gate on the key and the socket, pending turns, optimistic decisions,
  `ThreadDraft`); the README there has the rules. A read key hides nothing:
  the field and the cards carry the reason instead.
- Push (L6): the phone registers its APNs token with every paired host
  (`remote.push.register`/`unregister`/`status`/`activity`, capability read:
  the key's own row); the host keeps one row per key (`remote_push`,
  `src/main/server/remote/push.ts`) and forwards it to the hub as an `apns`
  subscription, which the hub delivers with token auth (infra/hub/src/apns.ts;
  the .p8, key id and team id are Worker secrets, never files). A notice
  carries `environmentId` and `seq`, so a tap opens the thread on the card
  through the same `Route.thread` a search hit takes; delivery while that
  thread is on screen shows nothing. The Live Activity (`ios/TempCode/Activity`,
  the TempCodeActivity extension; `Sources/Push/ActivityCoordinator.swift`)
  starts when the person sends a turn or watches a running thread, hands its
  push token to the host, and the host's `ActivityFeed` pushes the strip's
  phase on every transition and ends it (the final state stays two minutes)
  when the thread goes idle, waiting or errored. Settings has one row:
  the Notifications switch with its state beside it. Device build:
  `bun run ios:device` (scripts/ios-device.sh) builds with the newest
  Xcode's toolchain through DEVELOPER_DIR, automatic signing and
  `-allowProvisioningUpdates` with the team id from `TEMP_CODE_APPLE_TEAM`
  or the gitignored `ios/TempCode/Local.xcconfig` (`DEVELOPMENT_TEAM = …`),
  and installs on the connected or paired iPhone with `xcrun devicectl`;
  the simulator build stays ad hoc. DEBUG hook: `TC_TEST_ROUTE=notification`
  with `TC_TEST_NOTIFICATION="title part|seq"` feeds the delegate a
  hub-shaped payload; the proof's `push` set (in `all`) checks the landing.
  Delivery in practice: Cloudflare's fetch speaks HTTP/1.1 to origins and
  Apple refuses it, so the box sends itself (`src/main/server/remote/apns.ts`,
  node http2, the same payloads as the hub's) when `TEMP_CODE_APNS_KEY_PATH`,
  `_KEY_ID` and `_TEAM_ID` name the key (on the box: `/etc/temp-code/apns/`,
  root:agents 640, env in `/etc/temp-code.secrets.env`); with the key the
  host relays every registration locally, takes its devices back from the hub
  at boot and posts notices and Live Activity states over http2. The owner's
  APNs keys are Production-only, so the phone runs the Ad Hoc build
  (`TC_DEVICE_METHOD=ad-hoc bun run ios:device`: archive, export with
  automatic signing, install; `aps-environment` production, no DEBUG hooks,
  the pairing from an earlier Debug install carries over in the keychain).
- Tests: `bun run ios:test` (contract) and `bun run ios:test:client` (the
  package, pure suites plus a live suite against scripts/ios-client-test-server.ts,
  a real server with a read key that lives only in the test process
  environment); both run in the release gate. The test server seeds one
  thread per type with realistic rows and a 2,000-row chat. Simulator proof:
  `bun scripts/ios-sim-proof-local.ts` (every segment of every type, a chip
  opened, the diff, the agent detail, light and dark, then the scroll run
  whose frame report lands in /tmp/tc-ios-proof/scroll-report.json), or
  `TC_PROOF_SET=box TC_TEST_THREADS="a|b" scripts/ios-sim-proof.sh` with
  `TC_TEST_PAIR_LINK` from `tc-local remote.pairings.create` on the box; it
  drives the simulator with `simctl` because XCUITest cannot run while the
  Command Line Tools are the selected developer directory. The `actions` set
  (in `all`) re-pairs with the test server's acting key and performs every
  steering action, then reads back what landed from the control panel;
  `bun scripts/ios-sim-proof-box-actions.ts` is the live pass against the
  box: two pairings minted over `tc-local`, two claude-haiku-5-5 threads in
  /srv/agents/work/l5-phone-scratch, one real turn sent and answered, one
  approval decided on the card, then everything archived and revoked. Never
  put a pairing link or a key in a file or a log; the scripts scrub their
  output.

## The prod worktree is retired
~/IdeaProjects/temp-code-prod was the old local updater's build checkout.
The updater no longer reads it or the source repo at all; it can stay
detached as a scratch checkout or be removed. Never build into or swap
/Applications/TempCode.app yourself.
