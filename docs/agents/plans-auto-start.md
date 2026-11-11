# Plans: `plan_complete` and the auto-start

- A plan is finished when the planner calls the `plan_complete` app tool
  (planning threads only; refused while the plan file is empty) and the
  thread then settles. The planning preamble makes it the last tool call.
  The flow (src/main/server/planFlow.ts, settings in src/shared/plans.ts)
  runs on that settle, never mid-turn: with `plans.autoImplement` on
  (default; Settings → Thread defaults → Plans, overridable per project from the
  project's settings sheet) the host starts the implementation thread
  itself — same host, cwd, model, effort and context window as the plan
  thread unless `plans.implementModel` / `implementReasoning` /
  `implementContext` fix one — with planPath set, the plan thread seeded,
  the title from the plan's `#` heading; `implementationId` on the plan and
  `planThreadId` on the build link them, a `plan-handoff` row lands on the
  plan, and `plans.archiveAfterStart` (default on) archives the plan thread.
  The build, like every thread started with a first message (app_start_thread,
  spawn_agent, a cross-host `thread.start`/`thread.spawn`, `session.create`
  with `firstMessage`, which the renderer's `startThread` sends unless this
  Mac bridges that host), starts through `SessionRegistry.startWith`: the
  message is the thread's first row, flushed with the meta, or the thread
  is removed (`session-removed`) and the error is the caller's; the link,
  the handoff row and the archive wait for that row, and a failed
  auto-start lands a `plan-build` notice on the plan ("The build did not
  start: …"). A first message into a paused tree is stored as its row
  before it waits. Proof `bun run script:e2e-titled-threads`.
  The thread that started the plan (`startedBy`, set by app_start_thread,
  else `parentId`) is woken with a `<subagent-report>` through
  `deliverAgentReport`; a person-started plan whose build waits for them is
  the notifier's "Ready to build" (nothing once the build started: it says
  Done itself) and the "Plan ready" mark on its tab, its rail row (the
  rail reads `usePlanReady` once, `PlanReadyContext`) and the plan view's
  header (with the task count). Plan ready is `planCompletedAt` on a settled
  planning thread alone: nothing reads the plan file for it. With auto-start off
  the plan view's single Start build button (it opens the Start dialog,
  surfaces/threads/StartBuildDialog.tsx), the phone's Start a build sheet (its
  confirm is `plan.implement` since thread 25) and `plan.implement` over the
  wire start the build through the same function.
  Sending into a completed plan whose build has not started reopens it.
  Unit tests: planFlow.test.ts, plans.test.ts; proof
  `bun run script:e2e-plan-auto-implement` (three haiku planners on an
  in-process registry; `scripts/lib/electron-stub.ts` is the Bun preload
  that stands in for the claude driver's `nativeImage` import, so such a
  proof runs without an Electron runtime, on the box too).
