# Plans: one build per plan, and the project plan

- A plan's Start (desktop plan pane, phone Start sheet) starts ONE thread:
  an implementation thread, or an orchestration thread as the secondary
  action. The 1/2/3 worker count and the per-worker brief are gone.
- The `project-plan` thread type (docs/PROJECT-PLAN.md) writes
  `<cwd>/.temp-code/plans/project.md` with fixed sections (Goals, Current
  state, Milestones with scope/dependencies/done-when, Risks, Open
  questions; parser in src/shared/projectPlan.ts), calls the same
  `plan_complete` app tool as an ordinary plan (the section above): for a
  project plan the tool writes `status: complete` into the file's
  frontmatter (`ProjectPlans.complete`) instead of stamping `planCompletedAt`,
  so the plan flow's settle rule (`isPlanSettle`, planning threads only)
  never fires and a project plan NEVER starts a build on its own, whatever
  `plans.autoImplement` says. A complete plan ends with three buttons: Plan
  milestone N (a planning thread linked to the first undone milestone, then
  the ordinary single Start), Orchestrate milestone N, Revise… (a dialog
  whose text goes in as a new turn); the view header's "Project's plan"
  toggle keeps it as the project's plan (the header chip then reads "Plan"
  and `3/7`). A landed
  `project.mergeInto` ticks the milestone of every linked build
  (`ProjectPlans.landed`, src/main/server/projectPlan.ts); the checkbox in
  the plan view ticks by hand. State over `projectPlan.*` RPCs
  (src/shared/contract-projectplan.ts). Proof:
  `bun run script:e2e-project-plan` (a real haiku project plan, then a haiku
  milestone plan).
