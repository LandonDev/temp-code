const fn = () => {}

/** Every kind, for `bun run ui:preview …SurfaceSkeleton.tsx#SurfaceSkeleton`. */
export default [
  { name: 'Page (the Inbox)', props: { kind: 'page' } },
  { name: 'Page (Notes)', props: { kind: 'page', lines: 3 } },
  { name: 'Search', props: { kind: 'search', count: 8 } },
  { name: 'Column', props: { kind: 'column' } },
  { name: 'Accounts', props: { kind: 'accounts' } },
  { name: 'Pane', props: { kind: 'pane' } },
  { name: 'Diff', props: { kind: 'diff' } },
  { name: 'Terminal', props: { kind: 'terminal' } },
  { name: 'Frame', props: { kind: 'frame' } },
  { name: 'Transcript', props: { kind: 'transcript' } },
  { name: 'Diff rows, five', props: { kind: 'diff-rows', count: 5 } },
  { name: 'Rows, six', props: { kind: 'rows', count: 6 } },
  { name: 'Rows, Notes', props: { kind: 'rows', count: 4, lines: 3 } }
]

/** `…SurfaceSkeleton.tsx#LoadingLine --props` */
export const loadingLine = { label: 'Loading comments' }

/** `…SurfaceSkeleton.tsx#EmptyState --props`, bare and with a line and an action. */
export const emptyStates = [
  { name: 'Title alone', props: { title: 'No file changes' } },
  { name: 'With a line and an action', props: { title: 'No notes yet', line: 'Notes you write here stay with the project.', action: { label: 'New note', onClick: fn } } }
]
