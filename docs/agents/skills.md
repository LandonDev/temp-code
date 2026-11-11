# Skills: one store, materialized per host

docs/box.md "Skills: one store, materialized per host" is the long
account; the plans are .temp-code/plan--OsNna4IcfKO.md (the store core)
and .temp-code/plan-JBpcLz-eGMhp.md (the drivers).
- **What one is.** A folder with SKILL.md at its root and the files beside
  it (src/shared/contract-skills.ts), global or a workspace's, a workspace
  row shadowing the global one (`visibleSkills`). `skillProblem`
  (src/shared/skills.ts) refuses a SKILL.md whose frontmatter does not
  name the skill, unclean or secret paths, anything under `<skill>/scripts/bin/`,
  a native binary, past 512 files or 16 MiB, and the name `synced`. The
  `skills` and `skill_files` tables (src/main/server/skillStore.ts) hold a
  skill whole, written in one transaction; `skills.set` and `skills.remove`
  carry `expectUpdatedAt`. One copy, on the box, through `StoreSync` as
  for add-ons.
- **Where it is written** (src/main/server/skills/). views.ts: each
  provider (claude, codex, muse) has a `global` view, and a workspace has
  a `ws-<id>` view only when what its threads get differs. materialize.ts
  (`SkillMaterializer`) writes each view as a generation,
  `<userData>/harness/<provider>/<view>@<12 hex>/skills/<name>/`, built
  beside its place and renamed in, files 0444, an unchanged skill
  hard-linked from the last generation; `gc()` at boot and hourly removes
  a generation no view or scope pointer names. pointers.ts keeps one
  stable path per (provider, scope),
  `<userData>/harness/<provider>/scope/<global|ws-<id>>`, re-pointed by
  rename. skillText.ts localizes the other host's paths in text files
  through memory sync's path map. import.ts runs once, on the Mac: every
  skill under the home folders into the store (`skills-imported:v1`).
- **The app tools** (skills/tools.ts): `skill_list`, `skill_write`,
  `skill_remove`, deferred on Claude and listed by the bridge on every
  codex and Muse thread. A change to a skill a person or an import wrote
  last asks a card (Away allows it); a denial writes nothing; a skill that moved
  since it was read is refused; the answer waits for the write-out.
- **What each CLI reads.** Claude: `CLAUDE_CONFIG_DIR` is an owned dir per
  scope, `<userData>/harness/claude-config/<scope>/` (skills/claudeRoots.ts),
  its `skills/` one link per store skill through the scope pointer by its
  bare name, `synced` the person's account-synced bucket, every other
  entry a link into the person's dir; a routed Anthropic row holds
  `CLAUDE_CODE_OAUTH_TOKEN=routed` for the gateway; a live CLI calls
  `reloadSkills()` at the first send after its pointer moved; the warm key
  splits by scope alone. It is not a plugin dir, since a plugin's skills
  are always named `<plugin>:<skill>`. Codex (skills/codexSkills.ts): each
  home SKILL.md disabled per process (`-c skills.config`), the scope's
  generation as its extra root (`skills/extraRoots/set`), and `needsReboot`
  when a home SKILL.md appeared since the spawn. A `/skill` named in a
  message reaches Codex and Muse as one line pointing at the skill and its
  SKILL.md path, never the body (slash.ts `expandSlashRefs`; the Muse driver
  calls it too, and the slash menu lists a Muse thread's store skills);
  commands and prompts with no skill behind them are still inlined, and
  Cursor still gets bodies. Muse
  (src/main/server/museConfigDirs.ts): a config dir per (account, scope)
  whose `skills` links the pointer. Muse Code 1.4.14 also lists what it
  finds in other harnesses' home folders (`~/.agents/skills`,
  `$CODEX_HOME/skills`, tagged `origin-family`) and has no switch to stop
  it: a known gap, which the drivers' `--gate` reports on every run.
- **The home folders** (~/.claude/skills, ~/.codex/skills,
  ~/.agents/skills, ~/.config/muse/skills) are no live source after the
  import: never synced, never moved, renamed or deleted. What still reads
  them: the import itself; Codex's scan of the home SKILL.md paths at each
  spawn and turn, to disable them; Claude's `skills/synced` bucket, linked into the
  owned root; Codex's `.system`, which the slash menu still reads
  (commands.ts `configureCommandSkills`, `readHome: false`). Settings →
  Skills (src/renderer/src/surfaces/settings/skills/) says under its title
  that threads read skills from there.
- **The spike.** `bun run script:spike-config-dirs -- --host box|mac`
  (scripts/spike-config-dirs.ts) runs one experiment per id against
  loopback fakes; its answers are in .temp-code/findings/claude-config-dir.md.
  Rerun it after a CLI update.
- **Proofs.** `bun run script:e2e-skills-store` (two headless instances:
  the import, the seed, the views and their path text, a rewrite under a
  reader, the card, the slash menu, a restart) and `bun run
  script:e2e-skills-drivers`: its `--gate` runs the real CLIs of one
  headless instance against the spike's fakes (scripts/lib/spikeFakes.ts),
  and `--host box|mac` runs real turns by hand. Both `--gate` modes are
  publish rows.
- The skills drivers gate uses the user's `~/.bun/bin/bun` through
  `scripts/lib/proofBun.ts`, so an ancestor npm `.bin` cannot select another
  runtime. It waits for the gate build before starting that child.
