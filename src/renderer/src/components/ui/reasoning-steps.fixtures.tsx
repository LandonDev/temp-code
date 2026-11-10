// Fixtures for `bun run ui:preview src/renderer/src/components/ui/reasoning-steps.tsx#ReasoningColumn`:
// the reasoning column under the working line, as a thought streams.
const SHORT = "The inbox reads the table by owner. An index on owner and time would cover it. Still writing the";
const LONG = [
  "The inbox query filters by owner and sorts by updated time, so a full scan runs on every open.",
  "An index on owner and updated time would let Convex seek straight to the owner's rows.",
  "The search and the board read the same table, so the one index serves all three.\n\nThe schema has no index on the table yet, and the migration is only the schema change: Convex builds the index on deploy.",
  "I should check whether any query orders by created time instead, which the index would not cover.",
  "Then the tests: the inbox test seeds twenty rows and asserts the order, so it will catch a wrong index field.",
].join(" ");

export default [
  { name: "two sentences, a third still being written", props: { text: SHORT, live: true } },
  { name: "capped and scrolled: a long thought", props: { text: LONG, live: true } },
  { name: "settled", props: { text: LONG, live: false } },
];
