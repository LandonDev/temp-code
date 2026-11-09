# How the skills store reaches each CLI: findings of the config-dir spike

The probe is `bun run script:spike-config-dirs` (scripts/spike-config-dirs.ts, its sections in scripts/lib/spike{Claude,Codex,Muse}.ts, the pure helper scripts/lib/configDirSpike.ts with its test). It reruns every experiment after a CLI update. The redacted evidence of both hosts is under `.temp-code/findings/claude-config-dir/{box,mac}/`, one file per experiment; ids below (C1a, X3b, M4…) name those files.

## 1. Versions

| host | date | Claude Code (runs) | SDK and its bundled CLI | Codex | Muse Code |
|---|---|---|---|---|---|
| box (Linux x86_64) | 2026-11-09 | 2.1.303, login PATH | 0.3.280, 2.1.280 | codex-cli 0.163.0 | 1.4.14 (R7309.1), SDK 1.4.14, schema fingerprint matches |
| Mac (arm64) | 2026-11-09 | 2.1.312, login PATH | 0.3.280, 2.1.280 | codex-cli 0.164.0 | 1.4.14 (R7309.1), SDK 1.4.14, schema fingerprint matches |

No CLI changed during a run (C0 reads the version again at the end). Both hosts ran in several rounds the same evening as review fixed the probe; each id's file is its last round, and every Codex and Muse file comes from a run behind the egress guard (Limits).

## 2. Answers

**1. Does Claude Code load from a plugin directory outside `~/.claude`?** Yes. The SDK's `plugins: [{ type: 'local', path }]` loads skills, slash commands, agents, a `UserPromptSubmit` hook and the plugin's MCP server from any directory, on both hosts, on the login CLI and the bundled one, with `pluginDelivery` `argv` (one `--plugin-dir`) or `initialize` (`--await-initialize`, the list over stdin, `plugins_applied: true`) (C1a, C1b, C1g). Names are qualified by the manifest's `name` (`tc-store:tc-probe-skill`); with no `.claude-plugin/plugin.json` they are qualified by the directory's own name (`plugin:tc-probe-skill`, C1d). `skipMcpDiscovery: true` drops the MCP server and keeps the rest (C1c). The Skill tool and a `/tc-store:…` command both expand a skill's body; a skill already loaded in a conversation is not sent again. On CLI 2.1.312 the plugin's MCP tools are deferred behind ToolSearch and reached after a `select:` search (Mac C1a). `additionalDirectories` (`--add-dir`) also loads `<dir>/.claude/skills` under bare names (C1e), but it makes the directory a working root, which a store is not. When the person's own skills and the plugin hold the same name, the bare `/tc-dup-skill` expands the person's copy and only `/tc-store:tc-dup-skill` reaches the plugin's (C1f).

**2. What changes when the app sets `CLAUDE_CONFIG_DIR`?** The SDK's `initialize` over stdin works through `spawnClaudeCodeProcess` and the warm pool under an owned root: a warm process adopted in 82–88 ms, plugins applied, the skill invoked, and on the Mac a real turn through the dev gateway that answered with the skill's body word (C2f). The sign-in does not follow the root: an empty owned root is "Not logged in" on both hosts and sends nothing (C2a); Linux does not fall back to `~/.claude/.credentials.json`, and on the Mac no new Keychain item appeared for the new root (`Claude Code-credentials` alone before and after). Three ways to hand the root a credential all ran real turns on the Mac (C2b–d, real halves): `ANTHROPIC_AUTH_TOKEN` (token mode) sends neither `oauth-2025-04-20` nor `extended-cache-ttl-2025-04-11`, so the CLI is not in subscription mode and loses the one-hour cache; `CLAUDE_CODE_OAUTH_TOKEN` and a `.credentials.json` in the root keep both betas, and the file reads as `Claude Max` (C2b–d, fake halves). Fast mode was offered in all three. A one-turn check of `claude-sonnet-5-5[1m]` reported a 1,000,000-token window (C2b). With its shared entries linked into a home, the root kept every link through two turns (`.claude.json` was not replaced by a rename), memory, `CLAUDE.md` and `settings.json`'s env reached the request, and the transcript landed in the linked `projects/` (C2e). A session resumes under another root only when that root's `projects/` links to the first one's ("No conversation found" otherwise, C2g).

**3. Does a skill change reach a running CLI?** Claude: not on its own. After `reloadSkills()` an added, edited and removed skill all show, in a plugin and in the root's `skills/` alike (C3a, C3b); `reloadPlugins({ holdOnCacheImpact: true })` was not held, since no MCP server changed. The next spawn sees everything. For the warm pool the delivery mode decides: with `argv`, a process spawned before the change and adopted after it, under the same warm key, serves the old skills; with `initialize`, it serves the change, because plugins load at `initialize` (C3c). One warm process adopted by a query naming a different plugin set serves that set (C3d), so under `initialize` neither the plugin list nor its contents need to be in the warm key (C3e: no plugin path in the argv). Codex: the app-server watches its skill roots: `skills/changed` arrives, the running thread lists the added skill and drops the removed one, and a warm app-server opened before the change and a fresh one list all three changes, for `CODEX_HOME/skills` and for an extra root (X3, X3b). On 0.163 a skill part then sends the edited body; on 0.164 no request carried a skill's body, so which body a 0.164 thread reads is not observed. Muse: `skill/list` and skill resolution read the root at each call: the running session, a new session in the same `serve` and a fresh `serve` all serve the change; no `skill/changed` notification came (M4).

**4. Codex (`CODEX_HOME`) and Muse (`XDG_CONFIG_HOME`).** Codex has an add-a-dir route: the app-server's `skills/extraRoots/set { extraRoots }` lists skills from a directory outside `CODEX_HOME`, laid out flat (`<root>/<name>/SKILL.md`) or under `skills/`, and names their descriptions in the prompt (X1). On 0.163 a `skill` input part also sends the skill's body; on 0.164 it sent neither the body nor its path (X1, Mac). No config key or environment variable names a skills root (X0; config's `skills` only turns skills on and off). An owned `CODEX_HOME` with a ChatGPT-mode `auth.json` works against the fake and ran a real turn through the dev gateway on the Mac (X2c, on `gpt-6-luna`), an empty one has no ChatGPT login and falls back to the OpenAI API route with no credential (`POST /v1/responses`, no bearer, X2a), and resume across homes needs `sessions/` and the state databases linked (X2d). Hooks in an owned home fire only after a trust row keyed by the hook id `hooks/list` reports (X4); the app-server exposes no custom prompts (X5). Muse has no add-a-dir route: `-c` refuses every skills key tried, no environment variable names one, and `--trust-workspace` loads only `<workspace>/.agents/skills` and `<workspace>/.claude/skills`, not `.muse/skills` (M1). Skills in the owned root's `muse/skills/` list and expand by selector (M3). The owned root's `auth.json` is read with `TBH_CREDENTIAL_BACKEND=file` on both hosts; without it, Linux still read the file, and the Mac sent the root's login in two of three rounds and nothing in the first (M2, see Limits). Sessions live under `XDG_DATA_HOME/muse`, so a session resumes under another config root (M5). A `muse serve` started with an owned `XDG_CONFIG_HOME` passes it to its tool processes, and `gh` then loses its login while `git` keeps its config (M6).

## 3. Recommendation

### Claude Code: add a directory

Proven on both hosts: load (C1a–d, C1g), freshness (C3a–e), and no credential or history change, since the person's config dir stays as it is.

- **SDK options** on every query: `plugins: [{ type: 'local', path: '<store>/claude', skipMcpDiscovery: true }]`, `pluginDelivery: 'initialize'`. Both CLIs the driver can pick qualify (`initialize` needs 2.1.261 or newer; the bundled one is 2.1.280).
- **Tree the store writes:** `<store>/claude/.claude-plugin/plugin.json` (`{ "name": "tc-store" }`), `skills/<name>/SKILL.md`, `commands/<name>.md`, `agents/<name>.md`. Skills resolve as `tc-store:<name>`; the bare name reaches the person's own copy first while a synced copy still exists (C1f), so the store's names should be the qualified ones in prompts and the slash menu.
- **Freshness:** live. At the start of a turn whose CLI loaded the store before its last change, call `reloadSkills()` on the query (C3a). Without it, the next spawn.
- **Warm key:** nothing for the store. Under `initialize` delivery the argv carries no plugin path and a warm process serves the store as it is at adoption (C3c, C3d). Do not use `argv` delivery: its warm process keeps what it loaded at spawn under an unchanged key.
- **What breaks:** nothing moves. MCP stays with the add-on registry (`skipMcpDiscovery`); hooks stay with harness sync, though a plugin hook does fire (C1a).

### Codex: add a directory

Proven on both hosts: the listing and its freshness (X1, X3b). The body is proven on 0.163 only: there a `skill` input part sends the current body (X1, X3b); on 0.164 (the Mac) no request carried a skill's body or path, so the body a 0.164 thread reads, presumably by opening `SKILL.md` from the listed path, is not observed. The drivers thread should check it on the codex it ships with.

- **App-server call:** after `initialize`, before `thread/start`, on every app-server, warm ones included: `skills/extraRoots/set { extraRoots: ['<store>/codex'] }`. The call is per process and outside the warm key (binary, `app-server`, cwd and env).
- **Tree the store writes:** `<store>/codex/<name>/SKILL.md`.
- **Freshness:** live; codex watches the root and sends `skills/changed` (X3b).
- **What breaks:** nothing moves. Prompts have no app-server route (X5) and stay with harness sync, as do hooks and `config.toml`.

### Muse: no proven shape; hybrid is the closest (the owned root the app already makes)

No add-a-dir route exists (M1), so the store can only go where today's per-account root (museConfigDirs.ts) already is. The decision rule does not prove hybrid here: it asks for a real turn from the owned root that keeps subscription features, and the probe sends no Muse turn to Meta, by the plan's design. **Missing:** one real Muse turn on each host from an account root with `TBH_CREDENTIAL_BACKEND=file`. Everything else the rule asks for holds:

- **Environment:** `XDG_CONFIG_HOME=<userData>/muse-accounts/<account>` as today, plus `TBH_CREDENTIAL_BACKEND=file`, which museHost does not set today. Without it the root's `auth.json` decides the login on Linux but not reliably on the Mac (M2).
- **Tree the store writes:** `muse/skills/` in each account root becomes a real directory the store owns, holding the store's skills and a link per skill of the person's `~/.config/muse/skills` (today the whole `skills` entry is one link). `auth.json` stays owned; `settings.json`, `hooks`, `trust.json` stay linked.
- **Freshness:** live: every `skill/list` and skill part reads the directory (M4). Nothing to key.
- **Credentials and history:** the bearer the fake receives is the root's `auth.json` with the file backend (M2); sessions sit under `XDG_DATA_HOME`, untouched by the root (M5); the links survive (M5's root after a session). Today's Muse threads already run every turn from such a root, but without the file backend, so they do not stand in for the missing proof.
- **What breaks:** tool processes inherit the owned `XDG_CONFIG_HOME`, so `gh` and anything else that reads its config from there lose it (M6). This is true of today's Muse threads already; the drivers thread should pass the person's own `XDG_CONFIG_HOME` to tool processes if Muse offers a way, or set `GH_CONFIG_DIR`.

## 4. Harness sync under the store

| harness sync rule (remote/harnessSet.ts) | under the recommendation |
|---|---|
| Claude skills `~/.claude/skills` | The person's own stay and harness sync keeps carrying them. The store's skills reach each host as the store's plugin dir. |
| Claude commands `~/.claude/commands` | Same: the person's stay synced; the store's live in the plugin's `commands/`. |
| Claude agents `~/.claude/agents` | Same, with the plugin's `agents/`. |
| Claude hooks `~/.claude/hooks` | Harness sync keeps carrying them. |
| Claude settings `~/.claude/settings.json` | Harness sync keeps carrying it. |
| Claude plugins `~/.claude/plugins` | Harness sync keeps carrying the person's installed plugins; the store's plugin is a separate path passed by option. |
| Codex skills `~/.codex/skills` | The person's stay synced; the store's come from the extra root. |
| Codex prompts `~/.codex/prompts` | Harness sync keeps carrying them: no app-server route (X5). |
| Codex config `~/.codex/config.toml` | Harness sync keeps carrying it, trust rows included (X4). |
| Codex hooks `~/.codex/hooks.json` | Harness sync keeps carrying it. |
| Shared skills `~/.agents/skills` | Harness sync keeps carrying them. Muse reads `.agents/skills` only inside a trusted workspace (M1), not from home. |
| Muse settings `~/.config/muse/settings.json` | Harness sync keeps carrying it; each account root links to it. |
| Muse skills `~/.config/muse/skills` | Harness sync keeps carrying the person's; each account root's `muse/skills/` is the store's, with links to the person's skills. |
| Muse hooks `~/.config/muse/hooks` | Harness sync keeps carrying them; each account root links to them. |
| `~/.claude.json` `enabledPlugins` | Harness sync keeps carrying it; the store's plugin is not enabled there but passed by option. |
| `~/.claude.json` `mcpServers` | Harness sync keeps carrying it until the add-on registry owns MCP. |

## 5. What moves with an owned root

Nothing under the recommendation for Claude and Codex, whose roots stay the person's. For the record, from the hybrid and own runs:

- **Claude** (C2a–e, C2g): `.claude.json` with `.claude.json.lock`, `backups/` and rename temp files; `projects/<cwd>/` (transcripts, memory); `sessions/`, `session-env/`, `shell-snapshots/`; `plugins/store/` (Mac); `.credentials.json` where the login is a file. Readers on the host: the goal watcher, the stats indexer, memory sync, session move, aliax-core (`.claude.json`, the Linux credentials file). None leaked under the temp HOME.
- **Codex** (X2e): `auth.json`, `config.toml`, `installation_id`, `sessions/`, the state databases (`state_5`, `goals_1`, `logs_2`, `memories_1`, `queue_1`, `thread_history_1`, each with `-wal`/`-shm`), `shell_snapshots/`, `skills/.system/`, `.tmp/plugins`, `thread-writer-locks/`, `mcp-oauth-locks/`, `cache/` and `plugins/` (Mac). Readers: the stats indexer (`~/.codex/sessions`), session move, the slash menu (`config.toml`), aliax-core's codex adapter (`auth.json`). None leaked.
- **Muse** (M5): the root holds `muse/auth.json` and the links only; sessions (`session-index.db`), the plugin cache and tracing logs go to `XDG_DATA_HOME/muse`; nothing to state, cache or HOME. The recommendation owns `auth.json` and `muse/skills/`, links the rest, and leaves the data dir alone.

## 6. Host readers to change

- **Slash menu** (src/main/server/commands.ts): lists `~/.claude/skills`, `~/.claude/commands` and project skills by bare name. It must also list the store's Claude skills and commands under `tc-store:`, and the store's codex root for codex threads.
- **Muse host** (src/main/server/drivers/harness/museHost.ts `museEnv`): add `TBH_CREDENTIAL_BACKEND=file`; CLAUDE.md said it was there, it was not.
- **museConfigDirs.ts** `linkShared`: stop linking `skills` whole; the store writes `muse/skills/` with per-skill links to the person's.
- **The claude driver** (drivers/claude.ts options): add `plugins`, `pluginDelivery: 'initialize'`, and a `reloadSkills()` at a turn's start when the store moved. No warm-key change.
- **The codex driver** (drivers/codex.ts boot and codexWarm): one `skills/extraRoots/set` after `initialize`.
- **Unchanged under the recommendation**, because no root moves: the goal watcher (drivers/claude.ts:1337, `~/.claude/projects`), the stats indexer (aliax/stats/indexer.ts:21–22), memory sync (remote/memorySet.ts), session move (sessionMove.ts:97–98 `claudeConfigDir`, `codexHomeDir`), aliax-core's credentials and `.claude.json` readers. Any of them would need the thread's root if a harness ever owned its config dir.

## 7. Evidence index

Each row is one evidence file: its id, host, file and the probe's own verdict line (status, then each check: yes, no, or - for a check that did not run). A "no" is often the finding itself (C2a, C2g, X4, M1). `index.json` beside each host's files holds the same rows.

| id | host | file | result |
|---|---|---|---|
| C0 | box | `box/C0.json` | ok: runs 2.1.303 (Claude Code) (login PATH); login 2.1.303 (Claude Code), bundled 2.1.280 |
| C0 | mac | `mac/C0.json` | ok: runs 2.1.312 (Claude Code) (login PATH); login 2.1.312 (Claude Code), bundled 2.1.280 |
| C1a | box | `box/C1a.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcp yes, hook yes; names {"slash":"tc-store:tc-probe-skill","tool":"tc-store:tc-gone-skill"} |
| C1a | mac | `mac/C1a.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcp yes, hook yes; names {"slash":"tc-store:tc-probe-skill","tool":"tc-store:tc-gone-skill"} |
| C1b | box | `box/C1b.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcp yes, hook yes; names {"slash":"tc-store:tc-probe-skill","tool":"tc-store:tc-gone-skill"} |
| C1b | mac | `mac/C1b.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcp yes, hook yes; names {"slash":"tc-store:tc-probe-skill","tool":"tc-store:tc-gone-skill"} |
| C1c | box | `box/C1c.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcpAbsent yes, hook yes; names {"slash":"tc-store:tc-probe-skill","tool":"tc-store:tc-gone-skill"} |
| C1c | mac | `mac/C1c.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcpAbsent yes, hook yes; names {"slash":"tc-store:tc-probe-skill","tool":"tc-store:tc-gone-skill"} |
| C1d | box | `box/C1d.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcp yes, hook yes; names {"slash":"plugin:tc-probe-skill","tool":"plugin:tc-gone-skill"} |
| C1d | mac | `mac/C1d.json` | ok: skillListed yes, skillBySlash yes, skillByTool yes, command yes, agent yes, mcp yes, hook yes; names {"slash":"plugin:tc-probe-skill","tool":"plugin:tc-gone-skill"} |
| C1e | box | `box/C1e.json` | ok: listed yes, expanded yes; write access under --add-dir is not observable under bypassPermissions; the SDK documents it as a working-directory root |
| C1e | mac | `mac/C1e.json` | ok: listed yes, expanded yes; write access under --add-dir is not observable under bypassPermissions; the SDK documents it as a working-directory root |
| C1f | box | `box/C1f.json` | partial: bothListed yes, bareExpandsUser yes, bareExpandsPlugin no, qualifiedExpandsPlugin yes; listed tc-dup-skill, tc-store:tc-dup-skill |
| C1f | mac | `mac/C1f.json` | partial: bothListed yes, bareExpandsUser yes, bareExpandsPlugin no, qualifiedExpandsPlugin yes; listed tc-dup-skill, tc-store:tc-dup-skill |
| C1g | box | `box/C1g.json` | ok: argv.skillListed yes, argv.skillBySlash yes, argv.skillByTool yes, argv.command yes, argv.agent yes, argv.mcp yes, argv.hook yes, initialize.skillListed yes, initialize.skillBySlash yes, initialize.skillByTool yes, initialize.c… |
| C1g | mac | `mac/C1g.json` | ok: argv.skillListed yes, argv.skillBySlash yes, argv.skillByTool yes, argv.command yes, argv.agent yes, argv.mcp yes, argv.hook yes, initialize.skillListed yes, initialize.skillBySlash yes, initialize.skillByTool yes, initialize.c… |
| C2a | box | `box/C2a.json` | fail: turnAttempted no, realCredentialResolved -; apiKeySource none |
| C2a | mac | `mac/C2a.json` | fail: turnAttempted no, realCredentialResolved -; apiKeySource none |
| C2b | box | `box/C2b.json` | partial: placeholderSent yes, subscriptionBeta no, realTurn -; apiKeySource none |
| C2b | mac | `mac/C2b.json` | partial: placeholderSent yes, subscriptionBeta no, realTurn yes; apiKeySource none |
| C2c | box | `box/C2c.json` | ok: placeholderSent yes, subscriptionBeta yes, realTurn -; apiKeySource none |
| C2c | mac | `mac/C2c.json` | ok: placeholderSent yes, subscriptionBeta yes, realTurn yes; apiKeySource none |
| C2d | box | `box/C2d.json` | ok: placeholderSent yes, subscriptionBeta yes, realTurn -; apiKeySource none |
| C2d | mac | `mac/C2d.json` | ok: placeholderSent yes, subscriptionBeta yes, realTurn yes; apiKeySource none |
| C2e | box | `box/C2e.json` | ok: memory yes, claudeMd yes, settingsEnv yes, ownSkill yes, transcriptInFakeHome yes, linksSurvived yes |
| C2e | mac | `mac/C2e.json` | ok: memory yes, claudeMd yes, settingsEnv yes, ownSkill yes, transcriptInFakeHome yes, linksSurvived yes |
| C2f | box | `box/C2f.json` | ok: adopted yes, pluginsApplied yes, skillInvoked yes, realAdopted -, realSkill -; adoption 85 ms |
| C2f | mac | `mac/C2f.json` | ok: adopted yes, pluginsApplied yes, skillInvoked yes, realAdopted yes, realSkill yes; adoption 82 ms |
| C2g | box | `box/C2g.json` | partial: resumesUnderEmptyRoot no, resumesWithLinkedProjects yes |
| C2g | mac | `mac/C2g.json` | partial: resumesUnderEmptyRoot no, resumesWithLinkedProjects yes |
| C3a | box | `box/C3a.json` | ok: liveAdd yes, liveEdit yes, liveRemove yes, nextSpawnAll yes; first at {"add":"reloadSkills","edit":"reloadSkills","remove":"reloadSkills"} |
| C3a | mac | `mac/C3a.json` | ok: liveAdd yes, liveEdit yes, liveRemove yes, nextSpawnAll yes; first at {"add":"reloadSkills","edit":"reloadSkills","remove":"reloadSkills"} |
| C3b | box | `box/C3b.json` | ok: liveAdd yes, liveEdit yes, liveRemove yes, nextSpawnAll yes; first at {"add":"reloadSkills","edit":"reloadSkills","remove":"reloadSkills"} |
| C3b | mac | `mac/C3b.json` | ok: liveAdd yes, liveEdit yes, liveRemove yes, nextSpawnAll yes; first at {"add":"reloadSkills","edit":"reloadSkills","remove":"reloadSkills"} |
| C3c | box | `box/C3c.json` | partial: argv.adopted yes, argv.servesChange no, initialize.adopted yes, initialize.servesChange yes |
| C3c | mac | `mac/C3c.json` | partial: argv.adopted yes, argv.servesChange no, initialize.adopted yes, initialize.servesChange yes |
| C3d | box | `box/C3d.json` | partial: adopted yes, p2Applied yes, servesP2 yes, servesP1 no |
| C3d | mac | `mac/C3d.json` | partial: adopted yes, p2Applied yes, servesP2 yes, servesP1 no |
| C3e | box | `box/C3e.json` | ok: argvCarriesPluginDir yes, initializeKeepsArgvFlat yes; the owned root rides the env (CLAUDE_CONFIG_DIR), so it splits the warm key per root |
| C3e | mac | `mac/C3e.json` | ok: argvCarriesPluginDir yes, initializeKeepsArgvFlat yes; the owned root rides the env (CLAUDE_CONFIG_DIR), so it splits the warm key per root |
| X0 | box | `box/X0.json` | ok: schema yes, skillsList yes, extraRoots yes, hooksList yes; codex codex-cli 0.163.0 |
| X0 | mac | `mac/X0.json` | ok: schema yes, skillsList yes, extraRoots yes, hooksList yes; codex codex-cli 0.164.0 |
| X0b | box | `box/X0b.json` | ok: textTurn yes, functionCallRan yes; the fake is accepted |
| X0b | mac | `mac/X0b.json` | ok: textTurn yes, functionCallRan yes; the fake is accepted |
| X1 | box | `box/X1.json` | ok: extraRootsAccepted yes, flatListed yes, nestedListed yes, flatInPrompt yes, bodyBySkillPart yes, pathBySkillPart yes |
| X1 | mac | `mac/X1.json` | partial: extraRootsAccepted yes, flatListed yes, nestedListed yes, flatInPrompt yes, bodyBySkillPart no, pathBySkillPart no |
| X2a | box | `box/X2a.json` | ok: initializes yes, threadStarts yes, turnCompletes yes |
| X2a | mac | `mac/X2a.json` | ok: initializes yes, threadStarts yes, turnCompletes yes |
| X2c | box | `box/X2c.json` | ok: placeholderBearer yes, placeholderAccount yes, fakeTurn yes, realTurn - |
| X2c | mac | `mac/X2c.json` | ok: placeholderBearer yes, placeholderAccount yes, fakeTurn yes, realTurn yes |
| X2d | box | `box/X2d.json` | partial: resumesUnderEmptyHome no, resumesWithLinks yes |
| X2d | mac | `mac/X2d.json` | partial: resumesUnderEmptyHome no, resumesWithLinks yes |
| X2e | box | `box/X2e.json` | ok: inventoried yes, noLeaks yes |
| X2e | mac | `mac/X2e.json` | ok: inventoried yes, noLeaks yes |
| X3 | box | `box/X3.json` | ok: skillsChangedNotified yes, runningListsChanges yes, runningServesEditedBody yes, warmListsChanges yes, warmServesEditedBody yes, freshListsChanges yes, freshServesEditedBody yes |
| X3 | mac | `mac/X3.json` | ok: skillsChangedNotified yes, runningListsChanges yes, runningServesEditedBody -, warmListsChanges yes, warmServesEditedBody -, freshListsChanges yes, freshServesEditedBody - |
| X3b | box | `box/X3b.json` | ok: skillsChangedNotified yes, runningListsChanges yes, runningServesEditedBody yes, warmListsChanges yes, warmServesEditedBody yes, freshListsChanges yes, freshServesEditedBody yes |
| X3b | mac | `mac/X3b.json` | ok: skillsChangedNotified yes, runningListsChanges yes, runningServesEditedBody -, warmListsChanges yes, warmServesEditedBody -, freshListsChanges yes, freshServesEditedBody - |
| X4 | box | `box/X4.json` | partial: listed yes, firesUntrusted no, firesTrusted yes |
| X4 | mac | `mac/X4.json` | partial: listed yes, firesUntrusted no, firesTrusted yes |
| X5 | box | `box/X5.json` | fail: listedAsSkill no, expandedInTurn no; the method list names no prompts method (X0) |
| X5 | mac | `mac/X5.json` | fail: listedAsSkill no, expandedInTurn no; the method list names no prompts method (X0) |
| M0 | box | `box/M0.json` | ok: versioned yes, echoHostStarts yes, fingerprintMatches yes; muse Muse Code 1.4.14 (1.4.14-R7309.1) |
| M0 | mac | `mac/M0.json` | ok: versioned yes, echoHostStarts yes, fingerprintMatches yes; muse Muse Code 1.4.14 (1.4.14-R7309.1) |
| M0b | box | `box/M0b.json` | skip: skipped: needs --upstream (the Mac leg) |
| M0b | mac | `mac/M0b.json` | ok: recorded yes, modelListServed yes |
| M0c | box | `box/M0c.json` | ok: modelsListed yes, textTurn yes, functionCallRan yes; the fake is accepted |
| M0c | mac | `mac/M0c.json` | ok: modelsListed yes, textTurn yes, functionCallRan yes; the fake is accepted |
| M1 | box | `box/M1.json` | partial: appOwnedDirRoute no, trustWorkspaceLoadsMuse no, trustWorkspaceLoadsAgents yes, trustWorkspaceLoadsClaude yes; 7 routes tried |
| M1 | mac | `mac/M1.json` | partial: appOwnedDirRoute no, trustWorkspaceLoadsMuse no, trustWorkspaceLoadsAgents yes, trustWorkspaceLoadsClaude yes; 7 routes tried |
| M2 | box | `box/M2.json` | ok: fileBackendReadsRootLogin yes, defaultReadsRootLogin yes; default backend sent placeholder |
| M2 | mac | `mac/M2.json` | ok: fileBackendReadsRootLogin yes, defaultReadsRootLogin yes; default backend sent placeholder |
| M3 | box | `box/M3.json` | ok: listed yes, resolved yes, bodyReached yes; provider fake |
| M3 | mac | `mac/M3.json` | ok: listed yes, resolved yes, bodyReached yes; provider fake |
| M4 | box | `box/M4.json` | partial: skillChangedNotified no, runningListsChange yes, runningServesEdit yes, newSessionServesAll yes, freshServeServesAll yes; provider fake |
| M4 | mac | `mac/M4.json` | partial: skillChangedNotified no, runningListsChange yes, runningServesEdit yes, newSessionServesAll yes, freshServeServesAll yes; provider fake |
| M5 | box | `box/M5.json` | ok: sessionsOutsideConfigRoot yes, noHomeLeaks yes, resumesUnderRootB yes |
| M5 | mac | `mac/M5.json` | ok: sessionsOutsideConfigRoot yes, noHomeLeaks yes, resumesUnderRootB yes |
| M6 | box | `box/M6.json` | partial: toolSeesOwnedRoot yes, gitKeepsConfig yes, ghKeepsLogin no |
| M6 | mac | `mac/M6.json` | partial: toolSeesOwnedRoot yes, gitKeepsConfig yes, ghKeepsLogin no |

## 8. Limits

- **Fakes, not providers.** Every run but the real halves answered from loopback fakes that copy the wire shapes the CLIs accepted (Claude's Messages stream; the Responses stream for codex and Muse). The real halves checked the Claude credential variants and warm adoption on the Mac through the dev gateway. Review found traffic that left the machine in earlier rounds: X2a's no-login fallback reached `wss://api.openai.com` with no credential, codex's model refresh reached `chatgpt.com/backend-api/codex/models` with the placeholder token (refused 401), and the Muse launcher may check for updates with the root's `auth.json`. The probe now gives X2a `-c openai_base_url` at the fake (codex ignores `OPENAI_BASE_URL`; on 0.164 the setting also moves the ChatGPT-mode call, so only X2a gets it), runs every codex and Muse child behind a dead proxy with loopback exempt, and sets `MUSE_NO_AUTO_UPDATE=1` (since review round 2 also for M0's `--version` and `--help` calls; the Mac's M0 ran those three without it); the final evidence names no outside host. Claude's runs rely on `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- **The 1M window** was read from `getContextUsage()` after one short turn, not by sending a 200k prompt. Haiku reported the same 1,000,000 through the gateway, so the number may be the gateway's or the CLI's default rather than the model's.
- **Codex 0.164** (the Mac) opens a WebSocket first and reports "Handshake not finished" on the fake's 426 before falling back to HTTP; its `skill` input part carried neither body nor path (X1). The box's 0.163 sent the body. The recommendation does not rest on the input part: the listing and freshness held on both.
- **Codex gpt-6 models** sent requests with no `tools` field on 0.163 (X0b), so the fake runs used `gpt-5.5`; tool calls under the gpt-6 rows were not exercised.
- **Muse on the box** made its model calls to the fake with Meta's model list recorded on the Mac (M0b); Meta still serves the box's address an empty catalog, which the probe does not touch.
- **M2 on the Mac** differed between rounds: without the file backend, round 1 sent no request in 30 s (a Keychain lookup; the child denied a Keychain dialog that run), rounds 2 and 3 sent the root's login. The file backend is the only setting proven on both hosts every time.
- **X2c's real half** runs on the cheapest gpt-6 row, `gpt-6-luna`: a ChatGPT account refuses `gpt-5.5` ("not supported when using Codex with a ChatGPT account", an earlier round), which the fake runs use for its `tools` field. The codex recommendation does not change the login, so this half decides nothing here.
- **C2a** ran because no Claude login on either host holds a refresh grant (the guard); a login that holds one was not tested under an owned root.
- **The person's dirs** on the box changed under other threads during C2a (two files in `~/.codex`); the listings show what changed, not who changed it.
- **Write access under `--add-dir`** is not observable under `bypassPermissions` (C1e).
- **Codex hook trust** was shown for one hook with the hash codex computed; writing trust rows for a store's hooks is untested.
