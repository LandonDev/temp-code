# The renderer over time: React 19.3.1, the soak, a push re-renders only what it changed

- react and react-dom are 19.3.1: 19.2.8's development build wrote a
  `performance.measure` with a props diff for every component re-render
  with changed props and never cleared it, about 1.2 KB of native memory
  each, 51,000 a minute on the box: the 8 GB a dev window reached. 19.3.1
  clears each one at once (lib/reactDevMeasures.dom.test.tsx holds it).
- `bun scripts/measure-renderer-soak.ts` soaks a built tree's window
  (`--build prod|dev`, `--host synthetic|box`, `--view board|stream|split`,
  `--minutes`, `--every`, `--label`, `--tree`, `--gate`, `--scene
  board|chat|typing|switch|send|scenarios` (switch: the rail's two workspaces
  clicked in turn, each click timed to its column and strip and to its
  landing thread's rows, `--workspaces a,b`, `--clicks`, scripts/lib/soakSwitch.ts,
  a hand-run scene; docs/box.md "Switching workspaces"; send: messages sent
  from the master's composer into its 5,000-row history (`--history`,
  `--sends`, `--load-all` pages it all in, `--peer-delay <ms>` slows the
  synthetic host's answers), each timed to its row's first frame, to the
  composer emptying and to the host's answer, judged by `SEND_RULE`, a
  synthetic hand-run scene; docs/box.md "Sending into a long thread";
  scroll: the master's transcript, its board, the rail and the workspace
  column each turned by the wheel at 60 Hz for `--wheel` seconds and flung,
  every animation frame's interval kept, judged by `SCROLL_RULE`,
  `--surfaces`, `--host box` read-only, scripts/lib/soakScroll.ts;
  docs/box.md "Scrolling while threads work"; typing: the master's composer typed into
  beside its board in phases under the board's load, the master's churn and
  a 3,000-edit live-edit flood every 10 s, scripts/lib/soakTyping.ts, judged
  by `TYPING_RULE`; docs/box.md "Typing on a busy master"; scenarios: the no-jerk timeline of
  scripts/lib/soakScenarios.ts played once, with `--screencast <dir>`,
  `--reduced-motion`, `--scrolled-up`; never the gate; docs/TRANSCRIPT.md
  "No jerk in any scenario"), `--trace <s>` (scripts/lib/soakTrace.ts: main-thread frames
  by what they held, animation-frame and timer callbacks by function, busy
  time per renderer thread, each animation's compositing verdict),
  `--eval <js>` (an experiment run in the page); `--why` on a dev
  build tallies the props React's diff names as changed and who rendered
  them) on a fresh userData under /tmp/tc-soak, windowed (xvfb-run off
  macOS), and judges it (scripts/lib/soakJudge.ts). The synthetic host is
  scripts/soak-host.ts over scripts/lib/soakHost.ts (a real server in a
  child: bun with the electron stub on Linux, an esbuild bundle under node
  on macOS, whose bun has no node:sqlite; a pinned master,
  sixteen batch children, the fixed load of scripts/lib/soakLoad.ts; with
  `--scene chat` one plain chat thread with the focused child's load,
  CHAT_PROFILE, shown as a stream; with `--scene typing` TYPING_PROFILE,
  paused and resumed over the host's stdin;
  `bun run script:soak-host-check` proves the load reaches a socket, `--
  --scene typing` its live edits and the master's metas too); box
  mode pairs read-only and revokes at exit. The window opens through
  `window.__monocode.open(sessionId, { split })` (every build; lib/monocodeOpen.ts)
  and runs inactive and unthrottled (`TEMP_CODE_SOAK_WINDOW=1`, honoured
  only with TEMP_CODE_USER_DATA; src/main/soakWindow.ts). The gate rows
  `renderer-soak` (`--gate`: the board scene, split) and
  `renderer-soak-chat` (`--gate --scene chat`) each run a 50 s window
  inside 90 s (heap after GC ≤ +6 MB, RSS after GC ≤ +30 MB, no long task
  over 200 ms, ≤ 250 ms of long tasks a second, and CPU under the scene's
  bound, `GATE_CPU_PCT`: the scene's highest Mac figure plus a margin, board
  33% where it reads 29% on a quiet Mac and 20-22% on a busy one, chat 22%
  where it reads 15% busy; each fails the publish;
  `--cpu-report-only` reads CPU without failing for a hand run; docs/box.md
  "The soak's two scenes" has why the board cannot reach 12% while the
  phrase fade and the spinners stay as designed), and
  `renderer-soak-typing` (`--gate --scene typing`, about 65 s inside the
  same 90 s: keystroke to frame p95 ≤ 16 ms idle and ≤ 33 ms busy and fast,
  no long task over 100 ms while typing, every phase's text exact; CPU
  reported, not judged), and `renderer-soak-scroll` (`--gate --scene
  scroll`, about 40 s: 4 s of wheel and a fling on each of the four
  surfaces, every one moving and no long task while it does; the frame rate
  and the longest frame reported against `SCROLL_RULE` until a run on the
  Mac sizes them). Each soak in
  release-publish waits for `$STAGE/build.done`
  (TEMP_CODE_SOAK_BUILD_DONE), elsewhere it reads out/bundle-map.json's
  `head` stamp and builds when out/ is not HEAD's clean build. docs/box.md
  "The renderer over time" has the numbers; docs/RENDERER_RETENTION.md the
  bounds on the renderer's caches and logs.
- A push re-renders only what it changed, and these keep it so: an equal
  `session` push schedules no flush (store `mergeMeta` returns whether it
  changed anything); a thread row keeps its object while it reads the same
  (workspaceSessions `cachedRow`/`sameRow`), so do the rail's marks
  (`useWorkspaceMarks` computes outside React and shares mark by mark),
  the focused tree, the title bar's strip model and shelf
  (lib/keptValue.ts `useKept` with `sameSet`/`sameData`), a board row's
  meta while only the live context or an event's stamp changes
  (`sameShownMeta`), the board's agent summaries per changed child, and
  the approval toasts (`HiddenApprovalToasts` reads the store's
  pending-approval index, `usePendingApprovals`, ids, title, tool and label
  only, its builder installed by lib/approvalToast.ts so the store imports
  no transcript wording; chrome/toastSync.ts calls sonner only for added,
  changed or removed ids and dismisses an owner's toasts when it unmounts).
  A keystroke forces no layout and renders the field alone (the field sizes
  itself, lib/composerHeight.ts: only a paste, a restore, a quote or a
  replaced range eases its height, the inline height cleared after). A
  live-edit push costs one pass however many items it carries (store
  `applyLiveEdits`: one copy per session, one notify). A step's log line
  renders the board's foot alone: the batch state lives in a holder
  (useMasterModel.ts `BatchHolder`) the foot follows whole, the view reads a
  kept projection (`useBatchView`), each row is a memoized `BoardRow` and
  the master's chat is built only for new render functions; AgentTranscript
  is memoized. A scroll re-renders what scrolls: a virtualizer re-renders
  the component that holds it whenever its range or `isScrolling` moves, so
  it lives in a list component of its own (MasterView.tsx `BoardList`), and
  a scroller's children take no pointer while it scrolls
  (lib/scrollActivity.ts `QUIET_ATTR`, `SCROLL_QUIET_MS`; index.css), so rows
  sliding under a still pointer turn no hover. The rail card's clock reaches the time alone (`LineElapsed`,
  `CardAgo` on the shared tickers; `CardNowContext` fixes them for a
  fixture), and its master block, batch lines and agents lines are
  memoized. The composer keeps its session by `sameComposerChrome`
  (lib/session.ts `COMPOSER_FIELDS`, a proxy test fails on a read outside
  it) and reads its meta through `useSessionMetaValue`, one primitive at a
  time, so a busy master's activity renders no composer. A parked
  transcript (its tab behind `content-visibility: hidden`) reads and writes
  nothing on a resize or a push and catches up when it shows; its
  `--transcript-viewport` is written only when it moves (a custom property
  restyles every row under it). Every `RowsContextMenu` mounts its body on
  the first right-click (`lazyMount`, lib/lazyMenuGuard.test.ts). A component that only needs the metas when a
  menu opens or a click lands reads `sessionStore.metas()` then, never
  `useSessionMetas()`: a hook subscribed to the metas renders its component
  on every push, whatever it returns. Keep the hot parents compilable by
  the React Compiler: no ref read or write during render (latest-callback
  refs are written in a layout effect), no prop mutation, no cast in a
  computed key, and a ref callback taken out of its hook's object before it
  reaches a `ref` prop (`useDragResize` gives `attachPane`). In the
  transcript a delta re-renders the row it changed and the closing row:
  `RowView` compares its row by what it draws (`sameRow` in
  transcriptRows.ts), since the live turn's rows are new objects at every
  flatten; a settled turn keeps its row objects and their height estimates
  while its blocks array, its index and the row above it stay
  (`settledRows`, `estimateRowHeight`), so a send builds and measures the
  last turn's rows alone, however long the thread; and only
  the live turn's closing row is handed the session (`rowTurnState`; a
  notice reads it from context). Chrome that reads a thread's status, host
  or model never subscribes to its streamed text: the composer and the
  working strip get the session `useThreadChat` keeps while only streamed
  text changed (`sameSessionChrome` in lib/session.ts, `ThreadComposer`
  memoized, its callbacks stable), and a hook outside the pane reads it
  through `useSessionChrome` (the store), never `useSession`.
- Nothing that moves asks for a frame it does not paint: every requested
  frame runs the page's style, prepaint and layerize on the main thread,
  144 a second on a 144 Hz screen. The spinner turns the HTML box around
  its arc as a Web Animation (components/ui/spinner.tsx, `SPINNER_TURN`):
  on macOS a turn on the svg, CSS or Web Animation, ran a main-thread frame
  at every display frame, and a board's 35 spinners took 37% of a core. The
  streaming reveal (surfaces/smoothText.ts) steps whole words every 100 ms
  (`REVEAL.stepMs`, `revealCut` holding a bare block marker and a table's
  header row until they have content) and waits on a timer between steps;
  each step fades in as one span, a CSS opacity animation the compositor
  runs (`.stream-step`, lib/streamReveal.ts, a rehype plugin per streaming
  row, named per row because streamdown caches processors by plugin name),
  and the settle waits for the last fade (docs/TRANSCRIPT.md "The stream
  reveals a phrase at a time"). The working line's words shimmer
  (`WorkingText`: a masked band and its `::before` copy of the words moved
  by transform alone, every 3 s) beside its three-dot mark (`WorkingMark`),
  both Web Animations on the document timeline that the compositor runs,
  unmounted or still in a hidden pane or document. A streaming code block colours on a 150 ms throttle.
