# Project preambles: the house rules once per project

- Every brief for a project used to open with the same rules (worktree,
  gate, merge rule, what never to touch, which skills to use for UI). They
  are a **preamble** now: markdown on the project row (`projects.preamble`,
  `preamble_enabled`) edited from the project header menu → "Preamble…"
  (src/renderer/src/chrome/PreambleDialog.tsx, a large dialog: the editor
  and its word count beside a live preview, the switch under both, the
  variables in one mono line with their meanings on tooltips), and a
  workspace default (`workspaces.preamble`, the workspace menu → "Preamble…")
  for projects without their own. A project switched off carries nothing,
  whatever the workspace says. RPCs `project.setPreamble` and
  `workspace.setPreamble` (admin). The temp-code workspace's default is
  seeded once from the old house-rules block (`HOUSE_PREAMBLE`,
  `seedHousePreamble` at boot; marker setting `preamble-seeded:house`), so
  a cleared default stays cleared.
- Application: `decidePreamble` (src/main/server/projectPreamble.ts) runs
  in `SessionRegistry.send` on the FIRST message of a thread in a project,
  which every start path ends in: the composer, plan → build,
  app_start_thread (including on another host), spawn_agent children
  (`preamble: false` on the spec opts a child out; a child of a parent that
  opened without one opens without one; a parent on another host is
  unknown, so its child follows the project), a thread started over the
  cross-host `thread.start`, and the phone's New thread. The harness reads
  `## Project rules` + the text + `## The task` + what the person wrote,
  after the thread instructions and the project context. `{{worktree}}` (a
  slug from the thread title, or the first line of an untitled thread's
  message), `{{project}}` and `{{host}}` (the machine name) are substituted
  then; an unknown `{{name}}` stays as written.
- Display: the user-text row keeps the person's text as `text` and the
  rules as `preamble: { text, words }` (the stamp), so the transcript shows
  the brief with "Project rules 212 words" (the lead medium) folded above it
  (src/renderer/src/surfaces/PreambleRow.tsx; click opens the text). The
  thread keeps the text it started with: edits reach new threads only, and
  a first message held back by a failed boot reaches the harness with the
  block its row carries (`store.firstUserPreamble`). The pure parts live in
  src/shared/preamble.ts; proof is src/main/server/projectPreamble.test.ts
  (one test per start path).
