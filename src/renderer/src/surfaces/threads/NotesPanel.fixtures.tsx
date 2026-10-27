// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/NotesPanel.tsx#NotesView`.
const now = Date.now();
const notes = `## Goal

Make the right panel's sections read as one surface.

## Decisions

- Branch folds into Changes as its lower group.
- Notes edit in place.

## State

Slice 1 landed; slice 4 in flight.
`;

const base = {
  loading: false,
  text: notes,
  updatedAt: now - 120_000,
  saving: "idle" as const,
  editing: false,
  draft: "",
  remoteChanged: false,
  title: "A5: the right panel",
  cwd: "/srv/agents/work/temp-code",
  onEdit: () => {},
  onDone: () => {},
  onChange: () => {},
  onLoadTheirs: () => {},
};

export default [
  { name: "notes", props: base },
  { name: "loading", props: { ...base, loading: true, text: "", updatedAt: null } },
  { name: "empty", props: { ...base, text: "", updatedAt: null } },
  { name: "editing, the thread wrote meanwhile", props: { ...base, editing: true, draft: notes, remoteChanged: true, saving: "saved" as const } },
  { name: "save failed", props: { ...base, editing: true, draft: notes, saving: "failed" as const } },
];
