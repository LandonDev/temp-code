# Add-ons: one registry, every harness

docs/box.md "Add-ons and skills: one copy, on the box", "Add-ons: the
add-on host and its tools" and "Add-on grants: signed in on the Mac,
refreshed on the box" are the long account; the plans are
.temp-code/plan-uv2o7r5RN64s.md (data), plan-L1Vrd-CMiZJ7.md (host),
plan-8YMm3ynnFZYs.md (grants) and plan-vJP8mPAPorvc.md (pages).
- **What one is.** An MCP server every harness reaches through the one
  `app` server: a stdio command each host runs, or an http address
  (`AddonSpec`, src/shared/contract-addons.ts). Global (`workspaceId:
  null`) or one workspace's, a workspace row shadowing the global row of
  its name (`visibleRows`); ids `ad_` plus 12, names `ADDON_NAME_RE` (20 at
  most, so `<addon>__<tool>` fits Claude's 64). The rules are pure:
  `addonProblem` (no secret in `command`, `args` or `url`, plain http only
  to this machine, `tokenEnv` only with oauth) and `exposedNames` in
  src/shared/addons.ts.
- **Where it lives.** The `addons` table and this host's
  `addon_tool_cache` (src/main/server/addonStore.ts). No column holds a
  secret: `env` and `headers` name the values, which live in the grant.
  One copy, on the box: `StoreSync` (src/main/server/remote/storeSync.ts,
  beside RulesSync) has the Mac follow the box, seed each shared scope
  once, forward every write and refuse one while the box is out of reach;
  a workspace the box has no copy of stays the Mac's. The wire is
  src/main/server/storeRpc.ts: `addons.list` and `addons.tools` (read),
  `addons.set` and `addons.remove` (admin), the `addons` and
  `addon-status` pushes.
- **The add-on host.** Every downstream MCP client runs in a utility
  process of its own, `out/main/addonHost.js` (src/main/addonHostProcess.ts,
  forked by src/main/addonHostSpawn.ts), never in main or the gateway's
  child. src/main/server/addons/: addonChild.ts (one `Downstream` per
  launch), downstream.ts (the SDK client over stdio or Streamable HTTP
  with the SSE fallback, restarts on 1, 2, 5, 15, 60 s, every grant value
  redacted), addonHost.ts (main's side: respawned, down after three exits
  a minute; `doctor.get` names it). The process guard sweeps an orphaned
  stdio server by its `TEMP_CODE_ADDON` mark.
- **What each harness sees.** Claude: each visible ready tool registered
  live on its `app` server as `mcp__app__<addon>__<tool>`, deferred behind
  tool search (every claude spawn sets `ENABLE_TOOL_SEARCH=true`), its
  schema verbatim (addons/exposure.ts). Codex and Muse: `addon_find` and
  `addon_call` over scripts/app-mcp-bridge.mjs, listed only with
  `TEMP_CODE_ADDONS`, which is fixed at spawn, so a scope gaining its first
  add-on or losing its last reboots their handles at the next turn
  (addons/scopeFlip.ts).
- **The app tools and their cards** (addons/tools.ts): `addon_list`,
  `addon_add`, `addon_remove` (deferred on Claude, always on the bridge),
  `addon_find`, `addon_call`. `addon_add` always asks, and only a person
  with an admin key may allow it (`assertMayAnswer`: "forbidden: approving
  an add-on needs a person with an admin key"; a deny always passes), or
  the host itself while Away is on; a model never may.
  `addon_remove` asks only over an add-on a person wrote last; `addon_call`
  follows the permission (auto runs, edits runs a read-only tool, safe
  asks), its card `Use <tool> from <addon>?`.
- **Grants.** One aliax-core profile of the `addon` service per add-on
  (aliax-core/src/adapters/addon.ts at the commit package.json pins,
  80345ae), `internal`, so no account page lists it. Static when its blob
  has no `oauth` section: typed values reach every host and leave by
  tombstone. An OAuth grant is signed in on the Mac (a host with a
  window), handed to the box by accountSync's two-phase handoff and
  refreshed there; the Mac keeps an access copy. `AddonGrants`
  (addons/addonGrants.ts) reads the vault fresh, refreshes on a downstream
  401, keeps a grant ahead of its end, writes on one host (`writerOf`),
  presents typed values once to the add-on's `initialize`
  (addons/grantProbe.ts) and sweeps a grant whose row is gone. The sign-in
  (addons/oauthFlow.ts, addons/oauthCallback.ts) is PKCE S256 with
  dynamic registration on a fixed loopback port saved before the browser
  opens; every line it says is in src/shared/addonGrantWords.ts. RPCs
  (src/shared/contract-addonGrants.ts): `addons.grant.list` (read),
  `setFields`, `clear`, `refresh` (admin), `signIn`, `cancel` (local); the
  `addon-grants` push.
- **The page.** Settings → Add-ons (src/renderer/src/surfaces/settings/addons/,
  docs/LAYOUT.md "Settings → Add-ons and Skills"); Sign in… is desktop only.
- **Seams.** `TEMP_CODE_ADDON_TRACE=1` (a line per connect, list and exit),
  `TEMP_CODE_ADDON_GRANTS=<file>` (grant values from a file, honoured only
  with TEMP_CODE_USER_DATA), `TEMP_CODE_OAUTH_BROWSER=follow` (a sign-in
  that follows the authorize redirect with no browser).
- **Proofs.** `bun run script:e2e-addons` (two paired headless instances
  and fake MCP servers, scripts/lib/fakeMcpServer.ts, then one real
  claude-haiku-5-5 thread on this user's HOME) and `bun run
  script:e2e-addon-grants` (the same pair and scripts/lib/fakeOAuthServer.ts).
  Both are publish rows with `--gate`, which skips the real-Claude leg;
  docs/release-gate.md "The store and computer proofs" has their times and
  the codex first-turn medians with and without add-ons.
  Their process scans use scripts/lib/procScan.ts: macOS allows 64 MiB
  of output and scan failures never log captured process environments.
