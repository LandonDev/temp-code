# Muse Code: a harness of its own

Meta's Muse Code CLI is provider `muse` (`src/main/server/drivers/muse.ts`).
Meta brands it with the Meta symbol and publishes no Muse mark, so every
`muse` mark (HarnessIcon's `markDrawing`, the phone's `ProviderGlyph`) draws
Meta's, and its words tell the two apart (a model's tooltip ends "on Muse
Code"). `chrome/icons.test.ts` checks the distinct assets referenced by
`HARNESS_ICONS` against `assets/providers`; provider keys may share a file.
It runs
one `muse serve` per thread over the Muse Session Protocol (newline JSON-RPC
on stdio), spoken through Meta's `@muse-code/sdk` (pinned exactly, 1.4.14;
bundled into main like aliax-core, so electron.vite excludes it from the
externals). The spike's findings are `.temp-code/plan-R5k0vrmrvU4D/findings.md`
(F1–F10) and its recorded frames `src/main/server/drivers/fixtures/muse/`
(the README there); the SDK's schema fingerprint is the change detector and a
mismatch logs one `[muse]` line.
- `harness/museHost.ts` spawns the binary through the SDK's handshake and
  keeps the raw `Connection` (the facade drops `usage/changed` and lacks
  steer, cancel, `model/list`); `clientInfo.name` is `temp_code` (the wire
  refuses a hyphen); the environment is `harnessEnv()` plus the guard's marks,
  `MUSE_CONTRIBUTOR_MODE=0` (the person's code is not training data unless
  they turn it on) and `XDG_CONFIG_HOME` for the thread's config dir (one per
  account and skills scope, below). An account's dir also sets
  `TBH_CREDENTIAL_BACKEND=file`: the config-dir spike (M2; "Skills" below) found the
  dir's `auth.json` decides the login with it on both hosts, and without it
  only on Linux; the Mac's CLI may go to the Keychain first. The own dir
  (a thread on no account) does not. Both set `GH_CONFIG_DIR` to the
  person's gh dir when it is unset, since tool processes inherit the owned
  `XDG_CONFIG_HOME` and `gh` would lose its login (M6).
  `harness/museProtocol.ts` is the pure mapping: `safe` → `:ask-me` +
  `promptUnmatched`, `edits` → `:ask-me` + `onRequest`, `auto` →
  `:unrestricted` + `allowAll`; the app-tools bridge rides `session/start`'s
  `config.mcpServers.app` as a stdio server (the `sessionMcp` grant), so no
  settings file is generated; `turn/start` carries the effort on every turn
  (`minimal` joins the ladder with half 1; `none` is never sent); a steer is
  `turn/steer` on the live turn, received when the `userMessage` item with our
  `commandId` lands; Stop is `turn/cancel`; approvals answer `approval/decide`
  with the request's own `approved` choice, or `abort` (the wire offers no
  `denied`), never a session-wide or policy choice, and the app's own tools
  (`mcp__app__*`) are approved without a card; questions are
  `userInput/request` → the question card → `userInput/answer`;
  `session/contextUsage` is the context meter; `usage/changed` (the 5h and
  Weekly percent blocks) goes to `AccountsService.observeUsage` and a quota
  stop (`quota: tierLimit, resets …`, failureKind reads it as `rate_limited`
  on the 5h window) to `observeQuota`; the SDK's exit classification words the
  error row (`exited unexpectedly` keeps HARNESS_CRASHED); a Linux host whose
  `initialize` says the sandbox is unavailable restarts with
  `--disable-sandbox`; `TEMP_CODE_MUSE_TRACE=1` logs every frame.
- The catalog is probed at boot (`harness/museCatalog.ts`: `model/list`,
  `variants` the ladder, `isActive` the current pick and never a filter,
  labels from the ids: Muse Wonder 1.0, Muse Wonder Full 1.0, Muse Spark 1.3,
  1.2; the default is `isDefault`); it answers empty with no login, so the
  renderer's static rows stand in until then. Wonder Full
  (`muse-wonder-full-1.0`) is orchestrators-only by default
  (`defaultApproval` in rules.ts, which `withProbedDefaults` gives every
  probed row the rules never decided); Spark and Wonder are for everyone.
- Accounts: the login is static (`auth.json`: a device-code `access_token`,
  the minted `api_key` the model traffic presents, `user_email`,
  `subs_active`; no refresh, no expiry), aliax-core's `muse-code` service
  (adapters/muse.ts) captures the file whole and every host holds the copy
  (tombstones on delete). `src/main/server/museConfigDirs.ts` keeps one dir
  per (account, skills scope): `<userData>/muse-accounts/accounts/<account>/
  <scope>/muse/` with that `auth.json` (0600, by rename) and its digest in
  `.auth-seed`, or `<userData>/muse-accounts/own/<scope>/muse/` for a thread
  on no account, its `auth.json` a link to the person's own when they have
  one (`accounts/` and `own/` are fixed names, so no account collides with
  the own dir). In both, `skills` links the store's scope pointer ("Skills:
  one store, materialized per host"), which Muse reads at every call, and every
  other entry of the person's `~/.config/muse` (settings, hooks, trust) is a
  link; the driver hands the dir to `muse serve` as `XDG_CONFIG_HOME`.
  `migrateMuseDirs` at boot recaptures and removes the old
  `<root>/<account>/muse/` dirs. `isPickedProvider` (claude, codex, muse) is the gate for
  pins, the sticky account, the vanished rule and the chip
  (`isRoutedProvider` stays for what rides the gateway: headroom, 401 marks,
  the scope); a Muse pick lands at the next harness start, which the chip's
  menu says. Routing scores the observed windows and the live load alone;
  nothing polls Meta, and `muse usage` must never run against a copy (it
  rotates the access token in place; `recaptureMuseDir` on dispose saves only
  a scope's copy that differs from its own seed, the newest when several do,
  and seeds every copy it looked at with what it holds, so a scope's
  untouched copy is never saved over another's rotation). The Aliax app's Add account runs `muse
  login` (its CLAUDE.md). No gateway lane: `-c endpoint_transport.base_url`
  does carry every model call (findings F4) but no rate-limit headers were
  seen, so the lane buys nothing yet; warm start is left for later (the
  bridge binds at `session/start`, so a warm host can be rebound).
- On the box: `scripts/box/85-temp-code.sh` installs the CLI as agents; the
  harness set syncs `~/.config/muse/{settings.json,hooks}` and never
  `auth.json` (skills come from the store); account sync carries the login.
  Meta served the box's address an empty catalog in the spike (findings F2);
  on 2026-11-09 the catalog answered and the skills drivers proof ran Muse
  turns on the box, on an account and on the CLI's own login (docs/box.md
  "Muse Code on the box").
- Proof: `bun run script:e2e-muse` (scripts/e2e-muse.ts: an in-process
  registry on the real binary and the login its config dir holds; a shell
  call, a denied network approval, a steer received, a cancel; skips with one
  line where `muse` or the catalog is missing). Unit: muse.test.ts on
  `harness/museFakeServe.mjs`, museProtocol, museCatalog (the recorded
  `model-list.json`), museHost's exit words, museConfigDirs, museSettings,
  providerEnums, the rules, failureKind, binaries and sendSpans cases.
