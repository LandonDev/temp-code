# The project plan

A planning thread plans one piece of work for one build. The **project plan**
is the plan above those: one document per project that says what the
project is for, where it stands, and which milestones get it there, each
the size of one build. Milestones are planned one at a time, by a person
choosing from the plan's options; the project plan itself never starts a
build.

## One build per plan

A plan's Start (the plan pane header on the desktop, the Start sheet on
the phone) starts exactly one thread: an implementation thread, or, as the
secondary action, an orchestration thread that splits the plan across
subagents itself. There is no count of parallel implementation threads any
more; the per-worker coordination brief went with it. A plan that is too
big for one build is a project plan's job: split it into milestones.

## The `project-plan` thread type

- **Started** from the project header's `+` as "Plan the project…", from the
  phone's new-thread sheet, or from `app_start_thread` with threadType
  `project-plan`. Its mechanics (src/main/server/threads.ts, the
  `project-plan` preamble; orchestration.ts `projectPlanSpawnPrompt`) make
  it survey the whole project, spawning explorers for the parts it cannot
  read in one pass, ask the decisions that shape the plan, then write the
  document.
- **The file** is `<cwd>/.temp-code/plans/project.md`, one per project
  (`projectPlanPathFor` in src/shared/projectPlan.ts; `planPath` of the
  thread). Fixed sections, in order: `## Goals`, `## Current state`,
  `## Milestones`, `## Risks`, `## Open questions`. Each milestone is a
  `###` heading under Milestones, `### [ ] 1. <title>`, followed by
  `- Scope: …`, `- Dependencies: …` and `- Done when: …`. The parser
  (`parseProjectPlan`) reads the sections, the milestones with their three
  fields, and the frontmatter status.
- **`plan_complete`** is the app tool a planning or project-plan thread
  calls once the document is done (claude: the in-process `app` toolset;
  codex: the stdio bridge → `app.planComplete`). For a project plan it
  refuses a document that lacks a fixed section or has no milestone, else
  writes `status: complete` and a timestamp into the file's frontmatter
  (`ProjectPlans.complete`, src/main/server/projectPlan.ts). That status is
  the only completion signal the options card and the project header read.
  A later message in the thread revises the plan in place; the ticks stay.
- **Never auto-started.** Whatever an auto-implement setting says for
  ordinary plans, a project plan starts no thread on its own
  (`planMayAutoStart('project-plan')` is false; the preamble and the
  explorer mechanics say so too). The e2e proof asserts no thread exists
  after `plan_complete`.

## The options

When the plan is complete the plan view ends with a card, and the project
header's plan chip (see below) offers the same options:

- **Plan the next milestone** starts a planning thread for the first
  milestone not done, briefed with the plan file and the milestone's
  scope, dependencies and done-when (`milestonePlanningBrief`), titled
  `M<N> · <title>`, and linked to the milestone (`projectPlan.link`). That
  plan then flows through the ordinary single-build Start.
- **Start an orchestration thread for milestone N** starts the orchestrator
  straight from the project plan with the milestone's "Done when" as its
  goal, linked the same way.
- **Revise the plan** sends a new turn into the project-plan thread (the
  card asks what should change; empty means re-survey and update) and opens
  it. The thread edits the document in place and calls `plan_complete`
  again.
- **Keep as the project's plan** pins it (`projectPlan.pin`): the project
  header's chip then reads "Plan · 3 of 7 milestones done".

## Milestone ticks

A milestone is ticked in the file (`### [x] 2. API`) when:

- a build linked to it **lands its merge**: `project.mergeInto` succeeding
  for the project calls `ProjectPlans.landed`, which ticks the milestone of
  every implementation or orchestration thread of the project that carries
  a link. A build inherits the link of the planning thread whose plan it
  was started from (`inheritMilestoneLink`, in `SessionRegistry.create`),
  so the chain is project plan → "Plan the next milestone" → Start → merge
  → tick;
- or **by hand**: the checkbox in the plan view's milestone list
  (`projectPlan.tick`), which also unticks.

The pin and the links live in the settings table
(`projectPlan.pinned:<projectId>`, `projectPlan.milestone:<sessionId>`);
the ticks live only in the file.

## Where it shows

- **Desktop**: a project-plan thread opens in the plan view (ThreadView →
  PlanView): the document with `## Milestones` rendered as the live list,
  the pane header counting milestones done and marking a kept plan, the
  options card after a complete document. While the selected project has a
  project plan, the thread header carries a plan chip after the `+`
  (src/renderer/src/chrome/ProjectPlanChip.tsx): "Plan", or the milestone
  count once kept; it opens the plan and its popover holds the options.
  State comes from `projectPlan.get` (src/renderer/src/lib/projectPlan.ts),
  refreshed after every action, after a merge lands and whenever a
  project-plan thread of the project settles; the document itself is polled
  like every plan (usePlanFile).
- **Phone**: a project-plan thread has the Plan and Chat segments of a
  planning thread and renders through `ProjectPlanView`
  (ios/TempCode/Sources/Thread/ProjectPlanView.swift, on the plan page):
  the fixed sections as the document, `## Milestones` as native rows with a
  checkbox that ticks over `projectPlan.tick` (optimistic, reconciled on the
  next poll), the scope line, done-when and the dependency chips on expand,
  a progress line with the count, and the options card after `status:
  complete` (plan the next milestone, orchestrate it, revise, keep as the
  project's plan; the starts link the thread over `projectPlan.link`). The
  Home project header carries the chip ("Plan", or "Plan · 3/7" once kept;
  ProjectPlanChip.swift) with the same options in its context menu, on
  `projectPlan.get` cached per host and project. The parser is the client
  package's `ProjectPlan` (the Swift port of src/shared/projectPlan.ts);
  `projectPlan.get/pin/tick/link` are in the phone's subset. No Start on
  the phone for a project plan. docs/IOS-DESIGN.md "Project plan: the
  milestones are the hero".

## RPCs and tests

`projectPlan.get` (read), `projectPlan.pin`, `projectPlan.tick`,
`projectPlan.link` (operate), `projectPlan.linkOf` (read), `app.planComplete`
(local), in src/shared/contract-projectplan.ts and capabilities.ts.

Unit tests: src/shared/projectPlan.test.ts (paths, parser, ticks, status,
briefs, the auto-start rule), src/main/server/projectPlan.test.ts (state,
completion refusals, pin, ticks, links, landing, the handler),
sessions-project-plan.test.ts (file ownership, the preamble on the first
message, retype), threads.test.ts and orchestration.test.ts (the prompts),
apptools/app-bridge tests (the tool on both paths), and the renderer's
PlanStart (one build, no worker count), ProjectPlanCard, ProjectPlanChip
and PlanView.projectPlan dom tests. End to end:
`bun run script:e2e-project-plan` (scripts/e2e-project-plan.ts) runs a real
claude-haiku-5-5 project-plan thread on an isolated in-process server,
checks the file, the sections and `plan_complete`, then "Plan the next
milestone" with a haiku planning thread, the inherited link, the tick on
landing and the pin.
