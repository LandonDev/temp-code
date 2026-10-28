const fn = () => {}

/** The nine kinds, for `bun run ui:preview …SurfaceSkeleton.tsx#SurfaceSkeleton`. */
export default [
  { name: 'Page', props: { kind: 'page' } },
  { name: 'Column', props: { kind: 'column' } },
  { name: 'Accounts', props: { kind: 'accounts' } },
  { name: 'Pane', props: { kind: 'pane' } },
  { name: 'Diff', props: { kind: 'diff' } },
  { name: 'Terminal', props: { kind: 'terminal' } },
  { name: 'Frame', props: { kind: 'frame' } },
  { name: 'Transcript', props: { kind: 'transcript' } },
  { name: 'Rows, six', props: { kind: 'rows', count: 6 } }
]

/** `…SurfaceSkeleton.tsx#LoadingLine --props` */
export const loadingLine = { label: 'Loading comments' }

/** `…SurfaceSkeleton.tsx#EmptyState --props`, bare and with a line and an action. */
export const emptyStates = [
  { name: 'Title alone', props: { title: 'No file changes' } },
  { name: 'With a line and an action', props: { title: 'No notes yet', line: 'Notes you write here stay with the project.', action: { label: 'New note', onClick: fn } } }
]
