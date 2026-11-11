# Thread notes: the document that survives a compaction

- Every thread may keep `notes.md` at `attachmentDir(session)/notes.md`
  (the project's `.temp-code/attachments/<sid>/`, so the harness can read
  and write it with its own tools), mirrored in the `session_notes` table
  for the renderer, search and archived threads (src/main/server/
  threadNotes.ts; the text rules in src/shared/notes.ts). Five fixed
  headings: Goal, Decisions, State, Pointers, Open questions; the file
  keeps every heading, prompts and digests embed only the filled ones.
- The harness writes it with the `update_notes` app tool (apptools.ts;
  the codex bridge forwards it as `app.updateNotes`): one section per
  call, `replace` or `append`; the tool reads the file first, so a
  person's edit since the last call is never overwritten. Mechanics text
  (`NOTES_MECHANICS`, src/main/server/notesPrompts.ts) rides every claude
  system prompt through `orchestratorMechanics` and, for other harnesses,
  the first-message preamble's app-tools note.
- The app reminds the thread twice: a `<notes-reminder reason="context">`
  whispered into the live turn when the context meter passes 0.7 of the
  window, asking for an update only if the notes are behind; once per
  cause: a fresh window (below 0.5, or a compaction) clears its flag, and
  it re-arms only 15 minutes after the last reminder and never within 15
  minutes of an `update_notes` (`NOTES_REARM_MS`, notesPrompts.ts); and a
  `<notes-reminder reason="commit">` as the app's own short turn (a
  `turn-pass` marker reading "Notes") when a root thread's turn committed
  or merged (`isCommitCall`) without an `update_notes` call and none in the
  last 15 minutes; with a queued message the reminder rides ahead of it
  instead.
- A host line (a notes reminder, the notes block, a `<dev-server>` line, a
  master pin notice) never starts a turn of its own: `SessionRegistry.whisper`
  hands it to `DriverHandle.whisper`, which adds it to the open turn only
  where the model reads it before the turn ends (claude: the next tool's
  PostToolUse `additionalContext`, a matcher-less hook; codex and Muse:
  `turn/steer` with no client id), and holds it ahead of the next real
  message when the driver answers false, throws, lacks the method or hands
  it back unread (`DriverCtx.returnWhispers`: claude at the result, a dead
  stream, the watchdogs, dispose). Two threads looped on `update_notes` on
  2026-11-10 when a whisper pushed after a turn's last request ran as a
  turn of its own (docs/box.md "Thread notes"). `update_notes` refuses
  (`NOTES_STREAK_STOP`, src/shared/notes.ts, nothing written) after
  `NOTES_STREAK_LIMIT` (5) calls in a row with no other tool call or real
  input between (`notesStreak`; a send, a reports wake or a turn pass
  resets it, a host line or `note_decision` does not).
- After a compaction (`compaction` phase `done`) the thread's notes go to
  the harness as a `<thread-notes>` block, into the live turn or ahead of
  the next message; it asks for no write. Successors: a thread digest (`renderMirror`, so
  `app_read_thread`, `seedThreadIds` and `@thread:` references) carries
  `## Notes` verbatim between the frontmatter and `## Outcome`, and a build
  thread's first message carries its planning thread's notes
  (`<planning-notes>`) beside the plan seed.
- Wire: `session.notes.get` (read), `session.notes.set` (operate, the
  person's whole-text edit), the `notes` push to every client. The phone
  speaks all three (`ios/TempCode/Sources/Thread/NotesSheet.swift` on the
  client package's `notes` state, `Client/NotesState.swift`; the edit session is
  `Client/NotesEditor.swift`, the text port `Rendering/Notes.swift`; a
  waiting thread's needs-you row on Home reads its State line through
  `Shell/NeedsYouNotes.swift`). `session.search`
  folds notes hits in ahead of the rows (`source: 'notes'`, seq 0).
  Renderer: `lib/threadNotes.ts` (the store on the push) feeds the right
  panel's Notes section at every root thread's edge (`NotesBody` in
  surfaces/threads/NotesPanel.tsx: live markdown, edit with a debounced
  save, "Copy as brief" via `notesAsBrief`), the needs-you banner's State
  line, and the search icon.
- Proof: threadNotes.test.ts, sessions-notes.test.ts (reminders and their
  gap, the held whisper, the thrash reproduction, the streak, compaction
  block, digests, plan hand-off), claude-whisper.test.ts, the whisper cases
  in codex.test.ts and muse.test.ts, session-search.test.ts,
  app-bridge.test.ts, the renderer's threadNotes.test.ts,
  NotesPanel.dom.test.tsx and ThreadBanners.dom.test.tsx.