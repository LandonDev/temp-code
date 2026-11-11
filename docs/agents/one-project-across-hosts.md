# One project across hosts: linked projects, one rail, host glyphs

On each host, workspace creation matches real folder paths, so symlinks and
trailing slashes reuse one row; new rows keep the supplied path with trailing
slashes stripped. Once at boot (`workspaces-folded:v1`), old duplicates fold
into the oldest row with all project and session references and its link id
(or the oldest linked duplicate's id).

docs/box.md "One project across hosts" (five sections) and
docs/LAYOUT.md's sidebar rows are the long account; the proof is
`bun run script:e2e-linked-projects` (scripts/e2e-linked-projects.ts: two
headless instances; the linker stamps both copies, a far start into a
project with no copy creates and links it, a box edit reaches the Mac, a
Mac edit lands on the box, a Mac edit with the box down is refused, a
`@thread:` reference to a box thread yields its digest, `list_agents`
names the far child).
- **The link.** `workspaces.link_id` (`wl_…`) and `projects.link_id`
  (`pl_…`) are the ids a row shares with its copies on other hosts, on the
  wire as `linkId` on `WorkspaceMeta`/`ProjectMeta` (`projects.
  settings_updated_at` → `settingsUpdatedAt` beside it). Linking is automatic
  and has no UI: the linker (src/main/server/remote/projectLinks.ts) runs on
  the host holding the admin peer link (the Mac), on link-up, on the peer's
  `workspaces`/`projects` push, on a local catalog change and every 5 minutes,
  debounced; it pairs with the pure rules of src/shared/projectLinks.ts
  (workspaces by GitHub repo, else folder name; projects by name inside paired
  workspaces; the oldest row when a host has two of a key), decides with
  `decideLink` (one side's id adopted by the other, neither → mint, both
  different → the settings home's wins) and stamps through
  `registry.linkCatalog` here and `catalog.link` (admin) there. It never
  unlinks and never gives one id to a second row on a host; a wrong link is
  undone by deleting one copy, not by renaming it. The same run makes the
  copies still missing, both ways (`makeCopies`): a project with no link id,
  not archived, in a paired workspace whose other copy has no project of
  its name, gets a fresh id and `project.ensureLinked` there with
  `workspaceMustExist` (never a new workspace), and the source takes the id
  once the copy exists; so a project added on either host shows on the
  other within seconds, a host that was offline gets it at link-up, and an
  old one-host project on the next pass. A linked project's missing partner
  is one a person deleted and is never made again (no tombstone needed); an
  archived one gets none. A failed copy logs one line per new reason and
  leaves it on the source row (`ProjectMeta.linkNote`, `projects.link_note`,
  `catalog.link`'s `notes`), which the draft host picker shows on the other
  hosts, disabled; the next run retries. docs/box.md "One project across
  hosts: a new project gets its copies". `project.ensureLinked`
  (operate; src/main/server/projectLinks.ts) is the one function that finds
  or makes this host's copy: by link id, else the workspace by link id,
  mapped folder (`hostPathFor`) or repo, adopting a same-named unlinked
  project or creating one with the caller's name, branch and mode (a
  worktree on the caller's branch, a local copy with a note when that
  fails); no workspace → `cwd: null` and a note naming the folder; `dryRun`
  for the pickers. A cross-host `thread.start`/`thread.spawn` carries the
  caller's `project` facts (contract-crosshost.ts `ProjectLinkFactsSchema`,
  filled by crossHostAgents.ts from the project row, the ids minted once by
  `registry.projectLinkFacts`), `CrossHostThreads.place()` calls
  `ensureLinked` first, and `app_start_thread` with `environmentId` admits a
  `projectId` the far host lacks.
- **Settings live on the box.** The settings home of a link is its copy on
  the host whose hello `build.platform` is not `darwin` (two of one platform:
  the environment id sorting first; `settingsHomeOf`; `hostPlatform()` in
  src/main/buildInfo.ts is the one platform read, `TEMP_CODE_BUILD_PLATFORM`
  its seam for an isolated instance). `project.settings.get` (read) answers
  one bundle (name, archived, preamble, pins, review, plans, build, turn
  pass, `updatedAt`), `project.settings.set` (admin) writes it whole; every
  existing setter stamps `settings_updated_at` and pushes `projects`. The
  follower (src/main/server/remote/projectSettingsSync.ts, on the Mac) pulls
  a linked copy's bundle from its home when the home's stamp is newer, on
  link-up, the home's `projects` push and every 5 minutes; a settings write
  on a non-home host is forwarded to the home (then pulled back with the
  home's stamp) or refused with `refused: settings of <name> live on <host>;
  it is offline`. The dialogs (`lib/projectHome.ts`, ProjectSettingsDialog,
  PreambleDialog, rename, archive every copy, delete asking about the other
  copy) act on the home over its link, footer "Saved on <host>", Save off
  with the reason while the home is out of reach.
- **One rail.** `lib/linkedRail.ts` (`mergeRailSections`, restored from
  a39cc107 and keyed by `linkId`) joins copies into one row led by this
  machine's copy, the other copies aliased to the leader's keys
  (`aliasKeys`) so order, pins, recents, labels, logos, colours, mascots, the
  window folder and the selected-project memory (projectContext
  `folderKey`/`sameFolder`: a box copy's path reads and writes the
  leader's entry) keep theirs; one "Workspaces" section, no host headers, every copy's threads by
  recency, unread sums, Mark all read and the fleet switches over every
  copy, a down host's rows under the offline tint. A project card and the
  title bar's strip list the same roots of every copy: a thread is housed
  in a batch only under an unarchived pinned master the window knows
  (`batchHome` over `railMasters`, lib/threadStripModel.ts), and Archive
  dormant takes each master it archives with its settled batch
  (lib/archiveDormant.ts, loaded by `archiveDormantThreads` when the row
  is picked); docs/box.md "the card and the strip list the same threads".
  Host status is one Hosts
  row at the rail's foot (`HostsRow` in chrome/HostRows.tsx, two or more
  hosts only): a connection dot per host, coloured only in trouble, and a
  menu with a submenu per
  host (its state, the deploy drift, Switch to, Add workspace here, Mark
  all read, the fleet switches), then Host settings; a boot resume is a
  toast.
  `chrome/HostGlyph.tsx` (12 px, laptop for darwin, server otherwise, the
  name on hover, platform from the hello, remembered on the saved host row
  by `rememberPlatform`, preload for this machine; `lib/hostPlatform.ts`)
  marks every thread and agent row with two or more hosts: the rail, ChildRow,
  the right panel's Agents rows, the spawn row, the Inbox, search, the master board.
  `lib/projectHostChoice.ts` picks a new thread's host (`chooseCopy`: the
  thread on screen's when it is in the project, else the host "New threads
  start on" names when it has a copy and its link is open, else another
  connected host with a copy, else the named one offline; the draft
  rebuild's `preferredHost` reads the same). "New threads start on" is
  `box` (a host that is not a Mac, `startOnHostOf` in
  src/shared/projectLinks.ts, `settingsHomeOf`'s rule) or `mac`: the global
  value is `ThreadDefaults.startOn` (absent = the box; only the global set's
  counts; its row on Settings → Thread defaults shows with two or more
  hosts), a project's own is `ProjectMeta.startOn` (`projects.start_on`,
  `project.setStartOn`, admin, forwarded to the settings home, in the
  settings bundle; the project sheet's New threads section with "Use global
  setting", linked projects only); `startOnOf` takes the copy stamped last.
  No last-used host is remembered (`monocode.linkHosts` is gone):
  `chrome/DraftHostPicker.tsx` in the composer retargets one unsent draft,
  making the copy through `project.ensureLinked` on pick (a chat outside
  every workspace goes to the picked host's home, `retargetLooseDraft`); the master board's
  add sheet offers every host the same way and starts on the master's host
  (the thread on screen). The phone's draft row does not read the setting
  yet: it starts on the draft's saved host, else the project's lead copy.
- **Threads across copies.** `@thread:<env_…>:<id>` names a thread on
  another host (threadMentions.ts; the composer's picker emits the host's
  own id; the attachment carries `environmentId`); sessions.ts reads its
  digest over the new `thread.read` (admin, any thread of that host) into
  the same `.temp-code/refs/<id>.md`, or leaves one line `thread "<title>"
  on <host> is unreachable (<why>)`. The right panel's Agents rows already span hosts
  (the store is global; a far child keeps its parent's bare id).
- **Phone.** `ProjectPairs` folds by `linkId` alone, Home draws one row per
  linked project with the `HostGlyph`, the settings sheet saves on the home
  (`ProjectLinks.settingsHome`); the test server's `TC_IOS_SECOND_HOST=1`
  seeds the link; docs/IOS-DESIGN.md "Two hosts".
- **Tests.** shared/projectLinks.test.ts, remote/projectLinks.test.ts,
  server projectLinks.test.ts, crossHostThreads, crossHostAgents, apptools,
  projectSettingsSync, projectPreamble, sessions-mentions, threadMentions,
  mentionAttachments, agents; the renderer's linkedRail, MergedProjectRail,
  HostRows, BatchMenus, HostGlyph, HostGlyphRows, projectHostChoice,
  DraftHostPicker, AddThreadDialog, ProjectDialogs, projectHome,
  projectPairs; the phone's ProjectPairsTests,
  ProjectLinksTests, EnvironmentStoreTests, FixtureTests.
