/** The board's task list for `bun run ui:preview`: agents' real label
 *  lengths, so a cut row, the whole running row and the times all show. */
const running = [
  { id: "1", label: "Read the brief, the board's view and its tests, and v1.0.303's view of the same thread type", state: "done", time: { ms: 12_000 } },
  { id: "2", label: "Gate in parallel", state: "done", time: { ms: 124_000 } },
  { id: "3", label: "Make every task one line that fits the column, with the whole text on hover", state: "active", time: { ms: 41_000 } },
  { id: "4", label: "Run the publish gate beside the electron-vite build so the upload starts sooner", state: "pending" },
  { id: "5", label: "Docs", state: "pending" },
];

export default [
  { name: "a running pass", props: { tasks: running } },
  { name: "folded, a long running label", props: { tasks: running, defaultOpen: false } },
  {
    name: "a finished pass",
    props: {
      defaultOpen: false,
      tasks: running.map((task, i) => ({ ...task, state: "done", time: { ms: [12_000, 124_000, 380_000, 61_000, 900][i] } })),
    },
  },
];
