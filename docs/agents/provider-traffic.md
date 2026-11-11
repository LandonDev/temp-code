# Provider traffic: the gateway, and Codex needs 0.162.1+

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
  `TEMP_CODE_GATEWAY_TRACE=1` logs one line per forwarded request (its
  finish ends `client hung up` when the CLI left before the answer was whole).
  `TEMP_CODE_GATEWAY_SHAPE=1` (an isolated instance only, `shapeEnabled`)
  parses each scoped request's body, decoding its content-encoding (codex
  sends zstd), and logs one `[gateway:shape]` JSON line per request: every
  part by bytes (system blocks, each `Contents of <path>` file in a
  `<system-reminder>`, tools by MCP server, Responses input items by role and
  type, every other field), joined with the answer's input usage
  (src/main/server/gatewayShape.ts). Without the flag no body is parsed.
  `bun run script:measure-first-request` reads these lines
  (docs/agents/prompt-overhead.md).
- **The byte path runs in its own process.** On the Mac and the box the
  listeners, the forward, the SSE relay and the upstream pools run in an
  Electron utility process (`out/main/gateway.js`: src/main/gatewayProcess.ts
  → server/gatewayChild.ts, forked by src/main/gatewaySpawn.ts), not on the
  main process's one JavaScript thread. `GatewayCore` (server/gatewayCore.ts)
  is the byte path wherever it runs and asks a `ControlPlane` for accounts:
  `InProcessControl` (gatewayControl.ts: aliax-core's own reads and the
  server's hooks) in main, `PortControl` over a MessagePortMain in the child
  (protocol in gatewayWire.ts). Main (`GatewayHost`, gatewayHost.ts) keeps
  the marker (main's pid, the child's port), the TLS pair, the vault, the
  Keychain, every refresh and `askOwner`, the routing hooks, and mirrors of
  `url()`, `status()`, the codex ports and the warm map; it pushes the
  accounts the forward reads (names, pins, usage reports, the out marks)
  when the pickable set moves (`AccountsService.onPickable`; the out marks
  also after every 401 and answer), answers credential misses (the child keeps a credential until a
  minute before its token ends; a vault save or a 401 drops it), and gets
  one `response` message per answer with the limit headers. aliax-core's
  `ForwardHooks.accounts` is what keeps the child's copy of core off the
  vault. `adoptWarm` resolves on the child's word and the adopted CLI's
  stdin waits for it (`holdStdin`). A child that exits is respawned on the
  same ports (streams in flight are cut; the SDKs retry); three exits in a
  minute and the gateway runs in main (GatewayCore + InProcessControl), as
  it always does in tests and the in-process proofs. Child log lines read
  `[gateway:<pid>]`; `doctor.get` names the mode, pid and restarts.
  Proof: `bun run script:e2e-gateway-process`.
- The installed codex version is read once at boot (drivers/codexVersion.ts)
  and catalog rows with `minCodexVersion` above it are hidden everywhere
  (picker, spawn table, app tools). GPT-6.1 Sol and GPT-6 Sol need 0.162.1.
- Codex runs a turn on fallback model metadata (a 258,400 window, every
  tool inline) for a model its `model/list` does not name yet; one Mac
  thread's first request was 309k tokens that way and compacted after every
  request. The driver's first send waits for `model/list` to name the
  thread's model beside the MCP gate (`MODEL_LIST_WAIT`: every 250 ms, 10 s
  at most; an answer with no list says nothing and waits no more), writes
  `[codex] <id>: <model> not in model/list after 10s: first turn may run on
  fallback metadata` to stalls.log at the cap, and `first turn on fallback
  model metadata (window 258400)` once per handle when a listed model still
  reports that window (drivers/codex.ts, `recordDriverNote` in stalls.ts).
  Its `contextCompaction` items are `compaction` events: start at the item,
  done at the next token reading with `preTokens` and `postTokens` (or at the
  turn's end), so the thrash guard and the compaction row see Codex too.
- Vendor rows: Meta's `muse-wonder-1.0` and `muse-spark-1.3` sit in the
  catalog under both the claude and codex harnesses with `vendor: 'meta'`
  (`isMetaModel`) and a native 1,048,576-token window, so
  `supportsContext1m` is false and `[1m]` is never appended. The effort
  ladder (`REASONING_LEVELS` in src/shared/catalog.ts, the one list every
  reasoning enum reads) starts at `minimal`, which only the codex Meta rows
  list (the Claude CLI takes low..max); `fitReasoning` moves a rung a model
  lacks to its nearest, so minimal lands on low. The picker groups them
  under a "Meta" heading with Meta's mark (chrome/HarnessIcon.tsx `MarkId`;
  no model row draws a glyph, and out of its tab, in search and favorites,
  a row ends its name with its harness, since one model is offered under
  several), only
  while the thread's host holds a Meta key (`useAccounts`: no key, no rows
  in the Claude and Codex tabs, favorites or search; the Muse harness's own
  rows ride the subscription and never hide), and the
  board row's model mark draws it.
- The Meta Model API (Muse Wonder 1.0, Muse Spark 1.3) is the third
  upstream, behind the same two lanes. A Meta key is an account of the
  `meta` service in aliax-core (`accounts.saveApiKey`: the `LLM_<id>_…`
  shape checked, the key presented to `GET /v1/models` once, saved as a
  static ownerless profile whose account is the numeric id in the key, so
  the same key twice is one row; its usage report is that probe: "pay as
  you go", or "key revoked" with `expired`); it syncs like a one-year token
  (every host holds it, a tombstone removes it). A thread's accounts come
  from `routedProviderOf(provider, model)` (src/shared/accounts.ts): `meta`
  for a vendor row under any harness, else the harness; chooseAccount,
  resolvePin, the registry's expectAccount/liveLoad/refreshAccounts, the
  pins, the chip and the failure kinds all read it, and the route carries
  `service: 'meta'`, which `routeUrl` writes as `;s=meta` after the model
  (the codex https port's scope carries it too). The gateway reads the
  scope's service for the upstream (`https://api.meta.ai`, the lane's own
  path: `/v1/messages` or `/v1/responses`), the credential (`Bearer
  LLM_…`, no x-api-key, the CLI's chatgpt-account-id dropped), the limit
  classifier (a Meta 429 is transient with Retry-After: never replayed onto
  another key, since two keys of one team share the bucket; the host's
  headroom cooldown moves the NEXT turn) and the trace line (`service=meta`);
  every answer reaches the host with its `serviceId`, so headroom and the
  out marks land on the keys (Meta's `x-ratelimit-{limit,remaining}-
  {requests,tokens}` set is the one headroom.ts already parses; no reset).
  The key never reaches a child: the claude driver runs a Meta row in token
  mode (`metaClaudeEnv`: `ANTHROPIC_AUTH_TOKEN=routed` for the gateway to
  swap, haiku and sonnet pinned to Spark 1.3, opus and the subagent model to
  the thread's own, tool search on, never `[1m]`), the codex driver writes
  `model_providers.meta` on the thread's scoped https port plus `/v1` with
  the Responses wire and `TEMP_CODE_META_KEY=routed` as its `env_key`, the
  native window and reasoning summaries, no `chatgpt_base_url` and no
  `service_tier` (`metaCodexConfig`). A Meta model with no key on the host
  is refused at the send with "No Meta Model API key on this host"
  (`NO_META_KEY_MESSAGE`, kind `account_unknown`, the card offers Add key…),
  never sent unscoped to Anthropic or OpenAI; a 401/403 on a Meta route is
  `key_invalid` (Open accounts), 402 or billing words `quota`, 429
  `rate_limited` with Retry-After's seconds. `api.meta.ai` stays on
  Electron's `net.fetch` (not pooled) until the live smoke's trace says
  undici reuses h2 there. Proof: `bun run script:e2e-meta-routing` (a fake
  api.meta.ai, two keys, a claude-lane and a codex-lane turn, the 429
  cooldown); docs/box.md "Meta Model API".
- Speed tiers come from each CLI, never assumed: codex's `model/list`
  serviceTiers (drivers/codexTiers.ts) and claude's `supportedModels()`
  supportsFastMode, asked on the first claude init of a boot and cached as
  `claude.speedTiers` (drivers/claudeTiers.ts); the model menu offers only
  the listed tiers, and the drivers send a tier only when it is listed.
- A dev instance is not the marker owner, so core does not refresh codex
  tokens there: an account whose stored token lapsed answers 401
  ("token_expired") until the owner uses it. Pin test threads to an account
  the installed app uses, or expect that failure (its card reads
  `token_expired`).
- Every error row carries the host's verdict (`failure` on the event and the
  session row: `failureKind.ts`, stamped in `Sessions.append` from the
  harness's words, the gateway's last refusal for the thread and the
  routing), except a stop: the row of a turn the person stopped is stamped
  `stopped: true` and never classified. A turn the CLI ended itself (its
  result's `error_*` subtype, the row `turn ended: <subtype>[: <the CLI's
  first error line>]`) is kind `turn_ended`, summary `TURN_ENDED_SUMMARY`
  (the fallback's words), cause the CLI's line or the subtype's meaning; a
  line naming a death or a network cut keeps that kind. The stop rule
  (`stopping` in sessions.ts): the flag survives the `running` a question's
  or an approval's cleanup emits and a `waiting`, clears on a settle, on
  `starting` and at the top of `send()`; a Stop while the harness boots
  (`stopBooting`) puts the handle down when it lands, writes the stopped
  row and idle, and delivers nothing; a Stop on a paused turn writes the
  stopped row the pause dropped (paused takes no error row), so the turn
  closes Stopped and a batch child blocks as "was stopped". The
  transcript's FailureCard prints
  its two lines and at most
  three actions that fit the kind, Retry last, for every failure (a row
  with no verdict reads `fallbackFailure`, src/shared/failureFallback.ts,
  never the harness's raw words; Retry only where the host can continue,
  `canRetryFrom`, which admits a watching thread whose own last turn
  failed through the row's `canContinue` while `treeCanContinue`, the
  flag the rail and the cards read, still waits for its work); the tab edge prints the
  summary instead of "Failed", and the workspace popover prints it under
  the thread's title. A cap (`rate_limited`, `quota` on a picked provider
  but Meta) carries `roomElsewhere` (`AccountsService.roomElsewhere`: the
  spawn's `eligible()` over every account but the refused one) and names
  the account the gateway saw refused: with room the card is Route
  automatically, Continue on another model, Retry; with none, Continue on
  another model, Retry (the phone: Retry and the note). Continue on another
  model opens the composer's picker (`requestModelPicker(id, { onPick })`,
  called once after the picker's own change) and continues on the pick
  (`session.continue` with the model). With no room the thread is
  cap-held (`capHolds`): report and batch wakes park until a model or
  account change, a continue, the person's message or the cooldown's lift
  (`capLiftsAt`). A live handle whose thread moved since its spawn (model,
  effort, pin, or an account the registry moved while it was live: a
  failover, Route automatically on a watching thread, both through
  `pendingReboot`) is rebooted at the next turn start, never mid-turn
  (`staleHandle`, `rebootIfStale`; `dropHandle({ replacing: true })`
  writes no idle under the turn starting). docs/box.md
  "A failed turn says what happened". A window that refills to its limit on
  every request is `context_thrash` (src/shared/contextThrash.ts): the host
  ends a running turn, root or subagent, at the 4th compaction inside 10
  minutes (`noteCompaction` in sessions.ts: through the handle's interrupt,
  never a person's Stop; the driver's own row for the cut turn is dropped and
  the settle writes `context thrash: 4 compactions in 6 min; first request
  167k of 200k`, the first context reading after the harness's boot, and
  fails the row), and Claude Code's own "Autocompact is thrashing" line is
  the same kind. Summary "The context window keeps filling up"
  (`CONTEXT_THRASH_SUMMARY`); the card offers Continue with 1M context
  (`use-1m`: `session.tune { context1m }` then `session.continue`) when
  `supportsContext1m` and the thread is not on 1M yet, then Continue on
  another model and Retry; the phone another model and Retry. A batch child
  failed this way blocks its batch as errored with these words. Nothing in a renderer parses an error
  string; add a kind to `FailureKindSchema`, a rule to `failureKindOf`, its
  actions to `failureActions` and the phone's `FailureActions`, and run
  `bun run gen:swift`.
- Accounts across hosts (thread V): every profile in Aliax's `profiles.json`
  has an owner environment (absent = this machine) and only the owner ever
  presents a refresh token; other hosts hold access-only copies kept fresh
  over the main process's own peer links (`src/main/server/remote/peers.ts`,
  `accountSync.ts`; RPCs `accounts.push`/`accounts.pull`, admin only). The
  wire's `ServiceIdSchema` (src/shared/contract-m3a.ts) names every
  aliax-core service: claude-code, codex, cursor, meta, muse-code and addon
  (until 2026-11-08 it named the first three, so a Meta key or a Muse login
  sent to another host was refused at parse; contract-m3a.test.ts). A
  Claude "one-year token" is a static profile every host holds, with no
  owner: what `claude setup-token` makes, minted in-app (T1; aliax-core
  `src/mint.ts`, `src/main/aliax/{staticMint,staticTokens}.ts`) by adding
  `expires_in: 31536000` to the ordinary code exchange or to a refresh_token
  grant; the token response names its account and a token is filed only
  under that account. A Meta key is a key account (`kind: 'key'`, static, no
  owner, synced like a one-year token), added with the Meta section's Add key…
  (AddKeyDialog → `aliax:profiles:addKey` → core's `saveApiKey`) and shown as
  `LLM_1607…`; a refused key fails a turn as `key_invalid`. "Convert all to one-year tokens" in the Claude Code
  section's menu on the Accounts page converts every account; a grant
  another host refreshes (the box, from an
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
  (`StaticTokens.repairLive`). The "Sign in to Claude" window
  (src/main/aliax/signInWindow.ts) appears once claude.ai has painted,
  closes the moment the code arrives, and a failure is one line in the
  app's sign-in dialog (src/shared/signInWords.ts). With no Claude
  or Codex account on this machine the rail's foot leads with "Sign in to
  Claude" (chrome/SignInRow.tsx), which leaves once a profile arrives
  (docs/LAYOUT.md "First run"). Sign
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
  (Claude's Keychain item, Codex's auth.json, Muse Code's auth.json) is never
  handed off; a Muse Code login is static (no refresh grant), so every host
  holds the copy and routes its threads by it ("Muse Code: a harness of its
  own" below). Removals
  follow the owner (`AccountSync.deleteProfile`, behind the `accounts.delete`
  RPC and the Accounts page's `aliax:profiles:delete`): the vault row goes,
  the snapshot rebuilds at once (`AccountsService.rebuildNow`, no debounce),
  and every peer hears, over the links as `accounts.removed` (admin) and to
  sockets that pulled as an `accounts-removed` push; every pull answer also
  carries the sender's whole file (`listed`) and its tombstones. The
  tombstone rule: a host that deletes a profile it refreshes or a static
  token keeps a tombstone (settings row `accounts.tombstones`, 30 days,
  void once a profile of that account is saved there again); a peer deletes
  an access-only copy whose owner is the sender when the sender's list no
  longer has the account, and a static one-year token only when a tombstone
  names it (absence from one host's list proves nothing for a token every
  host holds); never deleted on a peer's word: a profile this host
  refreshes, the one its CLI is signed in with, or a provisional copy (a
  handoff in flight). Routing follows (`chooseAccount` reports `vanished`):
  a thread whose pin or sticky account is no longer known routes
  automatically from its next turn, the project's or workspace's pin for
  that provider is cleared, and one `notice` row (`kind: 'account-gone'`,
  a plain system row, no Continue) says "Account <name> is gone from this
  host; routing automatically from here" with the time; the chip reads
  Auto until the next pick lands. Test
  seams for isolated instances: `TEMP_CODE_ALIAX_DATA_DIR` (own vault,
  key-file mode), `TEMP_CODE_FAKE_PROVIDERS=<origin>` (every provider call
  goes there), `TEMP_CODE_GATEWAY_ROLE=owner` (refresh without the marker),
  `TEMP_CODE_DROP_ANSWERS=method:count` (swallow answers, for a dropped
  response), `CODEX_HOME` (the adapter's auth.json), `ALIAX_CREDENTIAL_BACKEND=file`
  + `CLAUDE_CONFIG_DIR` (the Claude CLI's credentials in a file inside the
  instance's data, never the Keychain), `TEMP_CODE_STATIC_RENEW_FIRST_MS` /
  `_EVERY_MS` (the renewal cadence); proofs are `bun run script:e2e-accounts-sync`
  and `bun run script:e2e-static-tokens`.
- Routing by headroom (src/main/server/{headroom,accountScore}.ts): the
  gateway's response hook records, per account and per host, the
  per-request limit headers every answer carries (Anthropic's
  `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-*` and
  unified status/claim, OpenAI's `x-ratelimit-*`), the answers of the last
  minute (the rate) and every 429/529 with when it lifts (retry-after, else
  the exhausted field's reset, else the unified reset, else 60 s; an
  overloaded answer pauses 30 s), in memory with `<userData>/headroom.json`
  written 5 s after a change and on close so a relaunch is not blind. For an
  auto thread `chooseAccount` scores every known account with room that is
  not out and not inside a cooldown: 0.45 × the least room among the model's
  usage windows, 0.30 × the tightest per-request limit left (an account no
  host has heard from counts as full), 0.15 × live threads against the soft
  cap, 0.10 × the cross-host rate against 30/min, plus 0.15 for Opus on a
  Fable-spent account; the best wins a first spawn, and a sticky thread moves
  only when the best leads its own account by more than 0.10 plus 0.25 ×
  cache warmth (1 right after its last answer, 0 after the prompt cache's
  TTL, an hour: the CLI writes the 1-hour cache, `STICKY.cacheTtlMs`; a
  `fresh` pick keeps only the cache term). A pinned account is
  the route regardless. Picks read the store live; the rows' snapshot
  (`headroom` per provider, the bars on the account chip's menu and the
  Accounts page's Rate bars, reset in their popover) follows at most
  every 5 s. The Accounts page is the one page on the table width (`Page
  width="table"`, 1,152px): from 48rem of its container each account is a
  table line with one column per usage window, its bar over when it resets
  ("Resets 4:15 PM" today, "Resets Thu 9:00 AM" past it, `resetWords`; how
  long until then on hover), the columns shared by the whole page, and an
  account out of room says "Limited" in amber with its reset (`limitOf`);
  under 48rem the columns stack under the name, two to a line in a narrow
  window (docs/LAYOUT.md "The Accounts page"). The rail's foot
  names no account: each provider's row is the pooled share from
  `src/shared/usageMeter.ts` (`meterFor`: the mean room over routable
  accounts, each its tighter of 5h and week) with the next refill, or
  "Limited 3m" while every account is throttled, and its popover lists the
  windows and how many accounts have room; Meta, paid per token, has a row
  only while every key is throttled (Limited and the time, no bar). Each host pushes
  its own picture to its peers every 30 s and within a second of a 429
  (`accounts.headroom`, admin; the answer carries the peer's), merged under
  the sender's id, so the Mac and the box pick from one picture. Proof:
  `bun run script:e2e-quota-routing` (an in-process server over a fake
  Anthropic: one account throttled, ten turns spread over the other ten).

- **Usage reset recovery** (accounts.ts, headroom.ts, remote/accountSync.ts):
  the Accounts page's existing Refresh usage button asks `accounts.refresh`.
  The host forces its own provider sweep and calls `accounts.refreshLocal`
  (admin, no fanout) on every connected peer, then exchanges headroom in both
  directions. A failed host produces one toast with its name and reason;
  other hosts still finish. The five-minute page timer only reloads views.
  The regular host poll uses the same recovery path without a click.
  Core's `onUsageSample` hook supplies timestamped windows through
  `usageSamples.ts`; cached answers and failed polls supply no proof.
  Each host keeps those samples in its own headroom entry and shares them
  over `accounts.headroom`. Newer samples replace stale usage windows in
  the accounts snapshot. A 429's `quotaWindow` names the exhausted window:
  only a later sample with room there, or that window's reset passing after
  the refusal, retires it. A legacy event without a scope requires proof
  for every window of its model. A full or missing report grants nothing.
  Transient 429s, 529 overloads and Meta's request limits keep their cooldowns.
  The 401 out marks stay separate: usage never clears a dead sign-in.
  The owner retires its own events; other hosts mask older events with the
  proof until that owner's next answer replaces them. Newer empty entries
  beat older snapshots even when the older one holds more events, and a
  peer can never write this host's own entry. Samples persist with headroom,
  so an offline peer catches up at link-up. A later refusal beats older room.
  Pickable changes recheck cap-held threads, including watching threads and
  those whose *other* account recovered. The hold lifts, parked report and
  batch wakes drain, and the accounts push updates the meter and Limited
  state. The latest failure's Route automatically action follows host state.
  A failed idle batch child still needs Retry/Continue from its master;
  refreshing does not replay failed work, which may have changed files or
  run tools before it failed. Muse uses only real observed `usage/changed`
  windows; refresh never runs `muse usage` against a copy. Meta's existing
  key probe has no quota windows and cannot prove a quota refill.
  Tests: accounts.recovery.test.ts, headroom.test.ts,
  remote/accountSync.headroom.test.ts, sessions-limits.test.ts and the
  Accounts page and FailureCard jsdom tests.

- Upstream connections (src/main/server/upstream.ts, the fetch aliax-core
  is configured with; core itself needed no change): api.anthropic.com rides
  undici pools, one per (origin, Authorization digest) so an account's turns
  share sockets, HTTP/2 when the API negotiates it (it does), 32 sockets per
  account, free sockets kept 90 s (the server's keep-alive hint lowers it),
  idle pools closed after 3 min. chatgpt.com stays on Electron's `net.fetch`
  (Cloudflare refuses Node's TLS there) with Chromium's own pool. Every
  TEMP_CODE_GATEWAY_TRACE line ends `reused=true|false h2|http/1.1`
  (`reused=n/a` on the Chromium path): undici publishes the request object
  and the socket it went on, and `upstreamTrace` ties them to the gateway's
  request. The fake provider (TEMP_CODE_FAKE_PROVIDERS) is pooled too, by
  the original origin.
- Deadlines (S7 of the stability sweep): a gateway control call (the
  child asking main for a credential, an account) times out at 30 s
  (gatewayWire.ts `GatewayControlTimeout`; a credential miss is
  `credential_timeout`, a 503 the failure kind reads as `network`); an
  upstream request on the pooled path has headers 60 s, body idle 120 s
  and total 10 min deadlines (upstream.ts; `TEMP_CODE_UPSTREAM_HEADERS_MS`
  and `_BODY_IDLE_MS` are the seams), the stage named in the failure; a
  codex app-server RPC past its timer (30 s, `turn/start` 60 s) fails the
  turn instead of hanging it, and one stalled at boot is released or
  retried. The gateway tells main when a forwarded request goes out and
  when it is done (`onRequestStart`/`onRequestEnd` on the control plane,
  the wire's `request` event); `chooseAccount` and `pickNext` share one
  `eligible()` rule, and a model's cooldown leaves the account's other
  models available.
- What a turn says while it waits (S3, Stability 3): a `phase` event is
  activity, never a row. The claude driver's spawn hook emits
  `cli-starting` for a cold spawn and `initializing` for an adopted warm
  process, until `system/init` (the boot's word is said again right after
  the send's `running`, `phaseAfterSend`, and nothing before the spawn, so
  a cold start never reads Initializing first; the registry keeps each
  session's live phase and a `starting` or `running` leaves its words as
  the activity; a phase that lands on an idle row is kept and surfaces at
  the send), then `waiting-provider` from init (or from the send on a live
  CLI) until the top lane's `message_start`, `retrying` on the CLI's own
  `api_retry` (attempt, delay, status); a thinking or text delta or a tool
  call clears any phase. Every claude spawn carries `--thinking-display
  summarized` (`claudeExtraArgs`): the SDK process otherwise asks the API to
  omit thinking text, and Fable and Opus thought for seconds over an empty
  row. The codex driver emits `retrying` on `willRetry`/`Reconnecting` and
  `initializing` while its first send waits on the MCP servers
  (`firstTurnGate`); sessions.ts words them ("Starting the CLI",
  "Initializing", "Waiting for the provider", "Rate limited, retry 3 in 32 s"; the vocabulary is
  src/shared/statusWords.ts: a comma before a phase's detail; a state word
  and its detail are two spans, or "Word: Detail" as one string
  (`plainStatus`); the host sends the detail as `SessionMeta.statusDetail`
  and keeps `activity` in its legacy two-space shape for old readers
  (`legacyActivity`), which `legacyDetail` reads with a capital) and folds them onto the
  meta like `context` (`phaseLine`). A provider request open past 15 s with
  nothing finer known (Thinking or the driver's own provider word) reads
  "Waiting for the provider, 25 s", re-pushed every 5 s (`providerRequest`,
  `PROVIDER_WAIT_MS`); only the turn's own requests count (a turn starting
  forgets those still open), and the gateway ends a request the moment its
  client hangs up, cutting the upstream (`RelayResponse` in gatewayCore.ts:
  codex closes its stream at `response.completed`, and core's relay once
  waited for a `drain` that never came; docs/box.md "The provider wait, and a
  client that hangs up"). The place these words show is the transcript's
  working line (`TurnLine` in surfaces/transcript/WorkingLine.tsx on
  `workingPhase` in workingPhase.ts): Sending while the person's row is
  still `pending` (not yet echoed), the meta's activity while the turn has
  nothing of its own, then the open wait on agents, the running call
  ("Reading format.ts", told by the line alone: `toldByWorkingLine`, no row
  until it settles), Thinking, and once a streaming thought has words
  "Thinking" with the block's seconds after it ("Thinking 4s", counted from
  the block's `startedAt` on the shared second hand) and its finished
  sentences in the reasoning column under the line (`ReasoningColumn`,
  components/ui/reasoning-steps.tsx, Kobra's Reasoning Steps; one phase key
  for the whole block, `thought:<id>`, spoken as Thinking; the column folds
  away when the thought ends),
  the mark alone under streaming prose; a phase stays at least 300 ms once
  painted and one that came and went inside the hold is skipped
  (`useHeldPhase`, lib/heldWord.ts); a change of phase morphs the words
  (`MorphText`), and the line becomes the closing line when the turn ends,
  once every row of the turn has finished revealing its text (AgentMarkdown
  reports `!settled` through `useReportReveal`, surfaces/revealDrain.ts;
  TurnEnd keeps the mark till then). Once live the line is never unmounted:
  held (a card, a pause) it folds on `.collapsible-auto`, a Stop morphs it
  to Stopped at once, and the echo keeps the optimistic row's key
  (`Block.rowKey`). A refold from the rows alone (an older page on a remote
  host, the head of a local tail-first paint) runs `reconcilePending`
  (lib/tcserver/fold.ts): the optimistic row records the seq its send
  followed (`Block.pendingAfter`), and a persisted user row past it in the
  refolded log is its echo (same text first, else the next in order) and
  takes the row's key; one with no echo yet stays pending first when the
  loaded rows start past that seq, last otherwise. Before it the refold
  appended the pending row under the whole stream and the line read Sending
  for the rest of the turn (a box master on 2026-11-08, after a resume that
  reset to a tail behind the echo). A thought is no transcript row (a group opened by hand shows its whole text in the entry's place, ThinkingRow.tsx).
  The timer above the composer counts from the click: `appendOptimisticUser`
  stamps `sentAt` when no turn is open, `turnStartOf` prefers it over the
  host's later `busySince`, the settle clears it, and the slot shows at once
  for a send over a failed or stopped row. A compaction is
  activity "Compacting context" (`COMPACTING_WORDS`) from its start to its
  outcome or the turn's end, never replaced by the provider-wait line or a
  mid-compaction `running`; the CLI re-sends its compacting status every
  30 s and the claude driver emits one start (the stream state's
  `compacting` flag). A first-output
  watchdog (`FIRST_OUTPUT_MS`, 60 s after a send with nothing back at all)
  settles the turn with the silence error and puts the process down; the
  registry re-queues the message once at the front, and a second silence
  on the same message leaves the row errored `harness_crashed`
  (drivers/silence.ts). A CLI resumed on a transcript whose background
  task died answers the task's notification before the pending message:
  the driver takes a `task_notification` ahead of the send's own content
  as a notice turn, holds that turn's result for `NOTICE_RESULT_GRACE_MS`
  (10 s; the row stays running, the clock untouched) and drops it at the
  next message, replaying it as the turn's own only when nothing follows.
  Every `session.send` writes one span line to
  stalls.log (sendSpans.ts: `send session=<id> accepted=0 prepared=12
  handle=340(warm) delivered=… init=… first-message=… model=1900(miss 88k)
  first-content=2100`, flushed at the first content or 15 s in, a phase
  never reached `-`; `model` is the top lane's `message_start` with the
  cache's word; the first send after an eager or focus boot reports how the
  handle came up (`warm`, `cold`, `live boot=focus`), a later one `live`;
  codex notes its MCP gate on `delivered`, `mcp=1400`; `bun
  scripts/stalls-summary.ts --sends` tables the gaps per handle kind, the
  warm share and the cache miss rate), and
  a meta push names its producer in the loop line
  (`meta:4038/781ids(accounts:3900,status:138)`).
- Pre-connect (src/main/server/preconnect.ts): when a turn starts on an
  idle thread, and when the composer of an idle thread gains focus
  (`session.preconnect`, operate; the renderer asks once per thread per
  half minute), the socket the thread's account will ride is opened or its
  free one refreshed with a `GET /` (404 in one round trip), never more than
  once per account per minute (`Upstream.preconnect`). The codex origin gets
  Chromium's `ses.preconnect` under the same throttle. Boot on focus: the
  person's own pointer or keystroke in the composer (`Composer` `onGesture`,
  `askOnGesture` in lib/preconnect.ts; never a programmatic focus, so a tab
  switch boots nothing) asks with `boot`, and the host boots the harness of
  an idle or done thread with none up or booting, not archived or moving,
  once per thread per 30 s (`FOCUS_BOOT_EVERY_MS`, on the host), only while
  `ThreadScheduler.hasRoom` (under the cap, nothing queued, memory clear;
  never the focused send's exemption); nothing reaches the transcript and
  `reclaimIdle` may put it down (`SessionRegistry.focusBoot`). An unsent
  draft asks with `draft` (provider, model, project): the router's socket
  for a fresh thread of that project, and the warm shapes in its folder
  kept another retire period (`touchWarm`); no session is created.
- Warm harness (src/main/server/drivers/warm.ts; claudeWarm.ts and codexWarm
  in codex.ts): a pool by shape, one pre-spawned CLI for each of the last
  `WARM_SHAPES` (3) shapes started, per driver per host, each spawned from
  the exact spec (command, argv, cwd, env) of a thread that started, no
  session and no account. A new thread adopts the one of its shape when the
  SDK computes the same spec (model, cwd, tools, permission mode, settings and MCP server
  names are all in the argv; a resumed thread never matches); the Agent SDK
  sends the system prompt, hooks and in-process MCP servers at `initialize`
  over stdin, so the adopted CLI is initialized as if just spawned
  (`spawnClaudeCodeProcess`). Its base URL is the gateway's `~w=<id>` scope,
  rewritten per request into the adopting thread's scope (`rebindWarmPath`,
  unscoped until then); only a thread our own gateway routes (the owner's,
  or no shim) adopts or warms. Codex: the warm `app-server` is spawned and
  initialized, everything per thread arrives with `thread/start`, so it
  saves process start and the handshake only (MCP servers attach at
  thread/start). A shape's replacement spawns 3 s after its adoption or
  cold start, at once when the shape started twice inside `WARM_BURST_MS`
  (60 s, a burst); a fourth shape retires the one that started longest ago;
  each shape retires 10 min after its own last start
  (`TEMP_CODE_WARM_RETIRE_MS` for a proof); nothing warms while memory is
  under the admission floor (`setWarmMemoryFloor`, index.ts; the proof seam
  `TEMP_CODE_E2E_MEMORY_LOW=1` on an isolated instance); a start that finds
  nothing logs the first field it differs on (`[warm] claude: miss
  (tools) 2 warm`: model, effort, tools, permission, settings, cwd,
  skills (the Claude config dir of another scope), resume, empty,
  refilling, memory). A warm process is never a session
  (not listed, counted, capped or load-guarded). `harness.warm` (admin)
  lists the pools with each process's retirement and the `misses` by
  field, and `{retire: true}` empties them; `TEMP_CODE_WARM_HARNESS=0`
  turns warming off. Measured on the box
  (`bun run script:e2e-warm-start`, chat threads, one turn each, two runs):
  Send → first token 2.9 s and 2.1 s cold (medians of 4; 1.5–3.3 s) versus
  0.30 s and 0.17 s adopted (medians of 3; 0.15–0.47 s) against the fake
  provider; one real claude-haiku-5-5 thread, cold, 3.06 s over a
  pre-connected HTTP/2 socket (every request after the first reused it).
  Stability 3 (2026-11-01): every pool, focus and memory case passes; one
  shape adopted 67–68 ms to the first thought, alternating shapes and a
  burst all adopted (69–91 ms), cold 0.21 s with Starting the CLI at 35 ms,
  and a real low-effort Opus thread streamed its thought (model at 2.7 s,
  the summary at 5.2 s). docs/box.md "Warm start" has the tables.
