# The desktop transcript: performance

The transcript (`src/renderer/src/surfaces/AgentTranscript.tsx`) is the
one surface that grows without bound: a chat packs 2,000 rows into 500
turns, an agent thread tens of thousands into two. This page fixes how it
stays cheap, how that is measured, and the numbers it must keep. It mirrors
the phone's rules in docs/IOS-DESIGN.md "Performance".

## Rules

- **Rows are the unit.** The thread is a flat list of rows
  (`surfaces/transcriptRows.ts`): one per turn item (a block, or a group of
  tool calls folded behind "+N previous"), one closing row per turn (its
  duration line, the live timer, the thinking tail), and a `more` row at
  the top for the remote profile's "Load earlier messages". A row is keyed
  by the id of its first block, so it keeps its identity as the window
  moves, as the live turn grows into it, and across a rebuild with older
  turns added above. Rows of a settled turn are cached per turn array
  (`stableTurns` keeps those arrays), so a streamed delta rebuilds the live
  turn's rows alone.
- **Only the viewport is mounted.** `lib/transcriptWindow.ts` (`RowLayout`)
  holds every row's height, estimated until measured, with offsets as
  prefix sums. The transcript mounts the rows that meet the viewport plus
  one screen of overscan each way (at least 400 px), each absolutely placed
  at its offset inside a container the height of the whole thread. The
  mounted range re-renders only when the viewport comes within half a
  screen of its edge, or it reaches two screens past it; a scroll inside
  the band renders nothing.
- **Measurement writes the DOM, not React.** One ResizeObserver measures
  every mounted row. A measurement writes the container height and the
  `top` of the rows below it straight to the DOM in the observer's pass
  (React writes the same values when it next renders), and moves the scroll
  offset by the growth of the rows above the reader's anchor row
  (`anchorShift`), so nothing under the eye moves. Rows at or below the
  anchor grow downward, away from the reader. Measured heights are kept by
  key, so a row that comes back is laid out at its true height.
- **The tail touches only itself.** While streaming, the live turn's rows
  are the only ones that render; the growing row changes its own box and
  the container's height. Rows are placed with `top`, not a transform: a
  transform per row is a compositing node per row, and Chromium's layerize
  step then costs about 2 ms on every token. Never put
  `content-visibility` or size containment on a row: the window measures
  natural heights.
- **Anchoring.** The scroll engine's modes are unchanged (`follow` rides
  the bottom on a spring, `parked` holds the prompt at the top over the
  runway, `free` leaves the reader alone; only the wheel, a scrollbar drag
  and keys release a mode). The reader's anchor row is read on every
  reader scroll and every engine write; rows landing above (a page of
  history, a turn regrouping) put it back where it was unless the
  transcript is glued to its end. Scroll memory across a remount is the
  anchor row and the offset into it (`TranscriptScrollMemory.anchor`), so
  the place survives heights being estimates again.
- **Jumps go through the window.** The minimap and a search hit name a
  block id; `scrollToRow` glides to a mounted row's box, or teleports to
  within 2.5 screens of an unmounted row's estimated offset, glides the
  rest, and lands exactly once the row is mounted and measured
  (`landing`). The parked prompt of an own send waits for its row to mount
  (`pendingPark`).
- **Markdown parses off the main thread.** A settled markdown row asks
  `lib/markdownParse.ts` for its tree; `lib/markdown.worker.ts` runs
  streamdown's own block split and remark → rehype chain (shared through
  `lib/markdownPipeline.ts`, so the markup is byte for byte what a
  main-thread parse gives) and answers one hast per block. The answer
  fills the hast cache under each block's text, which is the key
  streamdown's pipeline reads back through `restoreHast`, and the row
  mounts the cached tree with no parse on this thread. Until the answer
  the row holds its place with the text, unseen, in the same measure;
  nothing fades, since a row scrolling in is not an event. Requests are
  shared by row digest; the worker keeps its answers by digest too. The
  texts one commit asks for go to the worker together, the last asked
  first: rows ask top to bottom and a thread opens at its bottom, so the
  rows on screen parse before the screen of overscan above them.
  Streaming rows keep the incremental main-thread path, parsing the last
  block only. With no `Worker` (tests, node), or a worker that fails to
  load, throws, or gives no first answer within 8 s, every text is ready at
  once and the main thread parses as before: a row never waits on a worker
  that is not coming (`parseWorkerStats.failures` counts it). The worker
  bundles micromark, whose entity decoder picks a DOM build under the
  browser condition; electron.vite.config.ts aliases
  `decode-named-character-reference` to its plain build for the whole
  renderer, since a worker has no document.
- **Nothing animates on scroll.** A row born after the transcript opened
  fades in once, on its first mount; one that leaves the window and comes
  back is history. The fade is 150 ms of opacity, off under reduced
  motion. Jumps glide the scroll offset; under reduced motion they land.

## Opening a thread on another host

The time from a click to rows on screen for a box thread is round trips,
not bytes: from the Mac a request on the box's socket takes about 200 ms
(130–340 ms), the Mac's download runs at 3.5–5.9 MB/s, and a 300-row tail
of a long agent thread is 874 KiB to 1 MiB before deflate, about 150 KiB
after. The box answers it in 25–40 ms and the renderer folds its 4,000
event rows in 13–17 ms (box CPU).

- **One round trip.** Over a remote link a cold open sends
  `session.events { tail, subscribe: true }` (lib/connection/
  subscriptions.ts): the host puts the socket's listener on before the
  read, so a row appended after it is pushed and one before it is in the
  page, and answers `subscribed: true`. A local socket keeps the two plain
  requests. A host that predates the flag answers without it; the client
  then subscribes and folds the gap since the page's last row. A cold open
  that fails sends `session.unsubscribe`, since the host may have
  subscribed before the answer was lost.
- **The recently shown stay.** The store keeps the last `KEEP_RECENT` (6)
  transcripts whose panes left the mounted set loaded and subscribed
  (tcserver/store.ts `keptLoaded`), on top of the warm tabs; a switch back
  paints from memory with no request, and the rows it missed came as
  pushes. A reconnect replays their gaps with the mounted panes', the same
  bounded set, so nothing acts on a stale copy. Older ones unload as
  before.
- **A fetch belongs to its owner.** `Subscriptions.resume` joins a fetch in
  flight only when it was made for the same handlers; otherwise it waits
  that fetch out and sends its own. A transcript unloaded while a
  reconnect's gap fetch was still out (a slow host after a restart) once
  joined that fetch on its next open: the page went to the handlers that
  had left, nothing folded, and the load still finished `loaded`, so the
  pane showed the new-thread page over a master with 4,194 rows. Now a
  first load that ends with no page for its transcript fails into a retry
  ("no answer yet"), and the pane shows EmptySession only when the host
  answered with no rows (`load.empty`, set at `finishLoad` from the
  cursor); rows that fold to no blocks open the thread's own view.
- **Hover warms.** A tab or rail row hovered for 150 ms fetches its
  transcript (lib/hoverPrefetch.ts), which with a round trip of 200 ms is
  usually most of the way there by the click.
- A smaller first page was tried and dropped: from the Mac a 60-row tail
  (238 KiB) was no faster than the 300-row one (874 KiB) within the link's
  noise, and it would add a second request and a refold.

Measured 2026-10-22 from the Mac over the tunnel, three box threads of
3,400 to 4,200 rows in their tail, two opens each, medians of each run:

| | Before | After |
| --- | --- | --- |
| Socket round trip (`queue.list`) | 203 ms | 203 ms |
| Cold open: requests in series | 2 | 1 |
| Cold open: click to page (ms) | 333 and 272 | 215 and 175 |
| Switch back to one of the last six shown | a cold open | no request |
| On-screen markdown ready after the rows land (ms, box CPU) | 7–9 | 1–2 |

The after column's cold open is subscribe and events sent back to back
(one round trip, which is what the flag makes of them) against the box's
current build; the markdown row is the parse of the visible screen's texts
with and without the screen above them first.

## Budget

On the box (Xvfb, software GL, the profiling build), on the 2,000-row
chat:

- a cold open mounts under 40 rows and paints its rows within the app's
  own boot;
- scrolling the whole thread, either way, holds frames under 17 ms at p50
  and under 34 ms at p95, with no frame over 150 ms;
- a streamed token costs under 2 ms of main-thread time per appended row
  in React and layout together, and under 4 ms in all (the window's
  compositing included), with the live turn the only thing that renders;
- the heap stays under 35 MB with the thread scrolled through.

A regression on any of these is a bug in the transcript, not in the
thread.

## Measure

```
bun run script:measure-transcript-seed          # the database, once
TEMP_CODE_PROFILE=1 electron-vite build         # window.__app exists in profiling builds
bun scripts/measure-transcript.ts --label after # one pass; --only open|scroll|feed for one phase
```

`scripts/measure-transcript.ts` seeds a scratch userData under
/tmp/tc-transcript-measure with the chat the iOS test server seeds (500
turns of a prompt, a Read call and its answer, every seventh with a list
and a code fence), launches the built tree on a display of its own
(`xvfb-run` where there is none), and traces over CDP:

- **open**: the long thread selected, the page reloaded; ms from the page's
  time origin to `tc:transcript-blocks` and to the next paint, main-thread
  ms up to that paint, the longest task, mounted rows and DOM nodes. Both
  arms pay the same boot, which is most of the number.
- **switch**: a warm tab switch back to the long thread, to first paint.
- **scroll**: a reader's scroll (a wheel event, then 400 px per frame) to
  the top of everything, clicking "Load earlier" where it appears, then
  back down: frame times (p50, p95, max, frames over 17 and 50 ms),
  main-thread and layout ms, mounted rows and DOM nodes, the heap.
- **feed**: `window.__app.feed`, 8 s at 60 rows/s (thinking, then text
  deltas with a Read call every 40): main-thread ms per appended row, React
  commits and render ms, the top trace events, the heap.

Numbers vary run to run (open by a factor of two on a cold code cache);
compare medians of three, never one run.

## Before and after

Measured 2026-10-21 on the box (Linux, Xvfb, software GL, the profiling
build) on the 2,000-row chat; the median of three runs, with the spread in
brackets where it matters. Before is master at 8209800; after is this change.

| | Before | After |
| --- | --- | --- |
| Cold open: rows mounted / DOM nodes in the transcript | 102 / 2,096 | 14 / 322 |
| Cold open: time origin → first paint with rows (ms) | 643 [500–1,434] | 233 [233–642] |
| Cold open: main-thread ms up to that paint / longest task | 595 / 240 | 216 / 44 |
| Warm switch to the thread: first paint (ms) | 79 [45–106] | 15 [15–20] |
| Scroll to the top of everything: frames p50 / p95 / max (ms) | 50 / 150 / 1,350 | 16.7 / 16.7 / 17 |
| Scroll to the top: frames over 17 ms / over 50 ms | 416 / 187 (10 "Load earlier" pages) | 0 / 0 |
| Scroll to the top: main-thread ms / layout ms | 33,435 / 9,057 | 1,986 / 643 |
| After the scroll: rows mounted / DOM nodes / heap (MB) | 1,500 / 30,730 / 50 | 18 / 393 / 21 |
| Scroll back down: frames p50 / p95 / over 17 ms | 33 / 50 / 234 | 16.7 / 16.8 / 0 |
| Streamed turn (482 rows): React render + layout per row (ms) | 0.03 + 1.9 | 0.03 + 0.7 |
| Streamed turn: whole main thread per row (ms), thread scrolled through | 15.9 | 3.1 [3.1–3.2] |
| Streamed turn: whole main thread per row (ms), fresh open | 3.8 [3.7–4.2] | 3.1 |
| Streamed turn: task p95 / longest task (ms) | 18 / 120 | 2.5 / 21 |
| Heap after the streamed turn (MB) | 50 | 20 |

What the token numbers say: the transcript's own share of a streamed row
(React commit plus layout) is under 1 ms and no longer grows with the
thread; before, it grew with every row mounted (1,500 rows after a scroll
through the thread cost 15 ms a token). The rest of a streamed frame, about
2 ms, is Chromium's compositing of the whole window (`Layerize`, about
1.3 ms a frame), style recalculation and the engine's own frame, the same
on a fresh short thread before and after. That compositing cost is the
next lever, in the chrome around the transcript rather than in it.

Spread: open times vary by a factor of two with the code cache and the
box's load; the scroll and feed numbers are steady to within 20 % across
runs. `/tmp/tc-transcript-measure/<label>.json` keeps every run.
