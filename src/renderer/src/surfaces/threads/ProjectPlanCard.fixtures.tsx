// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/ProjectPlanCard.tsx#ProjectPlanCard`:
// the options a complete project plan ends with.
const doc = `---
status: complete
---
# Acme

## Milestones

### [x] 1. Data model
- Scope: tables
- Done when: the schema test passes

### [ ] 2. API
- Scope: the REST routes
- Dependencies: 1
- Done when: e2e passes

### [ ] 3. UI
`;
const session = {
  id: "pp",
  environmentId: "local",
  harness: "claude",
  model: "claude-opus-5-5",
  modelSettings: { effort: "high" },
  runtimeMode: "ask",
  title: "Plan the project",
  cwd: "/srv/agents/work/acme",
  projectId: "p1",
  planPath: "/srv/agents/work/acme/.temp-code/plans/project.md",
  threadType: "project-plan",
  status: "idle",
  blocks: [],
};
const state = (pinned: boolean) => ({
  projectId: "p1",
  path: session.planPath,
  exists: true,
  pinned,
  sessionId: "pp",
  complete: true,
  milestones: [
    { index: 1, title: "Data model", done: true },
    { index: 2, title: "API", done: false },
    { index: 3, title: "UI", done: false },
  ],
  missing: [],
});

export default [
  { name: "complete, not yet the project's plan", props: { session, doc, state: state(false), onStarted: "fn", onChanged: "fn" } },
  { name: "every milestone done", props: { session, doc: doc.replaceAll("### [ ]", "### [x]"), state: state(true), onStarted: "fn", onChanged: "fn" } },
];
