# The desktop transcript: a viewport window, markdown in a worker

- Renderer retention rules live in docs/RENDERER_RETENTION.md. An unfinished
  history head keeps every persisted row and only the newest partial input
  per tool call, in that call's first replay slot. The shared attachment
  cache is a 64 MiB LRU (two bytes per data URL character); failed reads
  retry. Host-job text keeps the last 512 Ki code units plus one truncation
  line, using the host's shared cap. Dev-run logs leave with their runs or
  host. Resource and Mac approval installers attach each existing link
  once through `onLink`'s replay. `perfMark` keeps at most 200 `tc:` marks,
  clearing the oldest name as a group; listeners still hear every mark.
- `src/renderer/src/surfaces/AgentTranscript.tsx` mounts only the rows that
  meet the viewport plus a screen of overscan each way. The thread is a flat
  list of rows (`transcriptRows.ts`: one per turn item, one closing row per
  turn, a `more` row for the remote profile's "Load earlier messages"), laid
  out by `lib/transcriptWindow.ts` (`RowLayout`: estimates until a
  ResizeObserver measures, offsets as prefix sums, the window range, the
  reader's anchor row, `anchorShift`). A measurement writes the container
  height and the offsets below it to the DOM and moves the scroll offset by
  the growth above the anchor row; the tail row growing while streaming
  touches its own box and the container height only. Scroll memory is the
  anchor row (`TranscriptScrollMemory.anchor`); the message list
  (surfaces/TranscriptOutline.tsx: the person's messages down the left
  side, a zero-height sticky child of the scroller placed by
  `outlinePlacement`) and search hits jump by block id through
  `scrollToRow`, which lands exactly once the row is measured (a keyboard
  jump with `instant`, no glide). Never put `content-visibility` or size containment on a row:
  the window measures natural heights.
- The streaming reveal (surfaces/smoothText.ts) holds a lead behind the live
  end (seeded 100 ms, 250 ms for another host's thread, grown by an
  underrun, decaying back), never runs slower than the stream, shows every
  character within 1.5 s of arriving, drains at the stream's end instead of
  snapping, and reveals a row born live (`RowBornContext`) from its first
  word (docs/TRANSCRIPT.md "The stream reveals a phrase at a time"). Inside
  an open fence a code line shows once its newline arrives (held
  `REVEAL.lineHoldMs`, then by words) and fades in as its own element
  (CodeBlock draws a `<span class="line">` per line, `splitColoured`; the
  row's reveal reaches it through `StreamRevealContext`, `lineTimes`); a
  list item, table row, heading, quote line or fence born mid-stream rises
  4px as it fades (`.stream-rise`); and a box that grows while it is read
  glides to its height (lib/heightGlide.ts `useHeightGlide`: the open tool
  table on the layout spring, a streaming code block's body on
  `--dur-base`), rows landing together staggered `--stagger-step` apart.
  `watchMotion` in the no-jerk runner and the soak's `--height-report`
  hold it.
- Settled markdown parses in `lib/markdown.worker.ts` (streamdown's own
  block split and plugin chain, shared through `lib/markdownPipeline.ts`);
  the answer fills the hast cache under each block's text and the row
  mounts the cached tree with no parse on the main thread
  (`lib/markdownParse.ts`, `useMarkdownReady`). Streaming rows keep the
  incremental main-thread path. With no `Worker` (tests, node), or one that
  fails, throws or never gives a first answer (8 s), every text is ready at
  once and the main thread parses as before; once the worker has answered,
  a request past 1.5 s parses that row alone on the main thread (the
  worker keeps serving the rest), a row that unmounts cancels its request,
  and the ready set is a 4,000-digest LRU tied to the hast cache. The renderer aliases
  `decode-named-character-reference` to its plain build (the DOM build has
  no document in a worker); keep that alias when touching the vite config.
- Opening a box thread is round trips (about 200 ms each from the Mac),
  not bytes: over a remote link a cold open is ONE request,
  `session.events { tail, subscribe: true }`, answered `subscribed: true`
  (an older host omits it and the client subscribes and folds the gap);
  the store keeps the last `KEEP_RECENT` (6) transcripts whose panes left
  loaded and subscribed, so a switch back sends nothing; the markdown
  worker parses one commit's texts newest first. docs/TRANSCRIPT.md
  "Opening a thread on another host" has the numbers. The local profile's
  `session.events` reads on the reader worker in 4 MiB pages
  (`registry.eventsAsync`), so the renderer's head walk ends on an empty
  page or at the tail's first row, never on a page shorter than it asked for.
- The scroll engine's frame loop rests once its glide, runway and follow
  spring have settled, running thread or not; new rows, the content
  growing, a resize and the reader's input start it again
  (docs/TRANSCRIPT.md "The follow loop rests when it has settled"). The
  editor's navigation past the end of a file waits at most 120 frames
  (surfaces/navigationRetry.ts).
- Measure with `bun run script:measure-transcript-seed` once, then
  `TEMP_CODE_PROFILE=1 electron-vite build` and
  `bun scripts/measure-transcript.ts --label <name>` (an isolated instance
  under /tmp/tc-transcript-measure on its own display; never the user's
  data). docs/TRANSCRIPT.md has the rules, the budget and the before/after
  table.
