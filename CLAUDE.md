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
- Pairing: an admin makes a code (`XXXXX-XXXXX`, 10 minutes, single use) in
  the pane or over `POST /api/pairings`; the link is `<origin>/pair#<code>`.
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
- Proof: `bun run script:e2e-remote` (the bearer flow against a temp
  server) and `bun scripts/e2e-remote-ui.ts` (an isolated preview instance
  plus a real Chrome profile over CDP through `/pair`, `/ui`, a thread, a
  reply, the cookie and the CSP rewrite).

## The Linux agent host: headless mode on the box
- `TEMP_CODE_HEADLESS=1` (src/main/headless.ts) runs the main process with no
  window, menu, dock or updater; the server, gateway, fixed-port listener and
  html preview's hidden window run as usual. A Linux process with no display
  is headless on its own. In that mode the local socket's port is published
  in `<userData>/server.json` and `scripts/box/tc-local.mjs` speaks to it as
  the implicit admin (`tc-local remote.pairings.create …` on the box).
- The box (`ssh box`, docs/box.md) runs temp-code from `/srv/agents/temp-code`
  as `temp-code.service` (agents user, agents.slice, Xvfb, a private D-Bus),
  data in `/srv/agents/temp-code-data`, env in `/etc/temp-code.env`; the
  tunnel maps `tempcode.landonhale.com` to its 7677. Deploy a ref with
  `scripts/box/apply.sh --from 85 --through 90`; proof from the Mac is
  `bun scripts/e2e-box-remote.ts`. Every "ask the login shell" call goes
  through src/main/server/loginShell.ts (`$SHELL`, else zsh on macOS, bash
  elsewhere): never hardcode /bin/zsh.

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

## The prod worktree is retired
~/IdeaProjects/temp-code-prod was the old local updater's build checkout.
The updater no longer reads it or the source repo at all; it can stay
detached as a scratch checkout or be removed. Never build into or swap
/Applications/TempCode.app yourself.
