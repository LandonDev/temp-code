// Fixtures for `bun run ui:preview src/renderer/src/surfaces/transcript/ThinkingRow.tsx#ActivityThinkingRow`:
// a settled thought, as a group opened by hand shows it: the whole text in the row's place.
export default [
  { name: "settled", props: { block: { id: "r1", role: "reasoning", text: "I read the file. Now I check the tests.", startedAt: 10_000, doneTs: 14_000 } } },
  {
    name: "a long thought",
    props: {
      block: {
        id: "r2",
        role: "reasoning",
        text: "The inbox query filters by owner and sorts by updated time, so a full scan runs on every open. An index on owner and updated time would let Convex seek straight to the owner's rows.\n\nThe search and the board read the same table, so the one index serves all three. The schema has no index on the table yet, and the migration is only the schema change: Convex builds the index on deploy.\n\nI should check whether any query orders by created time instead, which the index would not cover. Then the tests: the inbox test seeds twenty rows and asserts the order, so it will catch a wrong index field.",
        startedAt: 10_000,
        doneTs: 22_000,
      },
    },
  },
];
