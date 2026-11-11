# The fleet switches: one click for every thread of a scope

Pause all, Resume all, Stop all and Archive done sit beside Mark all read in
a project's menu (rail row and project header; on a project linked across
hosts they act on every copy, one `session.batch` per host), a host's
submenu in the rail's Hosts row (`HostsRow` in chrome/HostRows.tsx, with two
or more hosts), and the Threads menu for everything; a project card in the
workspace column offers Pause all, Resume all and Stop all over the project
and its linked copies (the `projects` scope, `ids` of every copy), its
archiving staying Archive dormant. Roots only, subagents follow their parent; a row with nothing to
act on is disabled. The rules per row and the toast line are
`src/renderer/src/lib/threadBatch.ts`, the confirm copy with its live count
`lib/threadBatchCopy.ts` (out of the first paint; both unit-tested); the
confirm is red for Stop, and for Archive done only while its removal box is
ticked;
the menus' rows are `threadBatchMenu.ts`; the dialog and toast are
`chrome/ThreadBatchDialog.tsx` and `chrome/ThreadBatchToasts.tsx` (a sonner
toast per batch, through `chrome/toastSync.ts`). Pause,
Stop and Archive confirm; Resume and Mark all read do not. The server side
is `session.batch {action, ids, cleanup?}` (operate), answered by
`SessionRegistry.batch` through `src/main/server/sessionBatch.ts`: ids
mapped to roots once, the existing per-session calls four at a time, every
id answered. `registry.resourceCleanup` (null today) is where the
thread-resources build hangs its clean-up; `setResourceCleanup` in the
renderer turns the Archive done checkbox on. Proof:
`bun run script:e2e-thread-batch`. docs/box.md "The fleet switches". The
phone has the same rows in its host and project menus
(ios/TempCode/Sources/Shell/FleetSwitches.swift over the client package's
ThreadBatch.swift, the rules and copy ported with tests mirroring
threadBatch.test.ts), one `session.batch` per host.
