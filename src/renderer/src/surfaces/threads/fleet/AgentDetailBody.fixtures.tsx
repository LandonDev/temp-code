// A18: the agent detail's header in three states, for a static look.
import { agentStatus } from "../../../lib/threads/agents";
import { FLEET, fixtureMeta } from "./fleetFixture";

const working = FLEET[0].meta;
const waiting = fixtureMeta("q", {
  title: "Choose the cache",
  agentType: "explorer",
  status: "waiting",
});
const done = FLEET[2].meta;

export default [
  {
    name: "Working, every number",
    props: {
      meta: working,
      status: agentStatus(working),
      branch: "feature-x",
      parts: [
        { key: "diff", adds: 140, dels: 12 },
        { key: "tasks", text: "3/7 tasks" },
        { key: "context", text: "42% context" },
        { key: "cost", text: "$0.12" },
        { key: "elapsed", text: "4m 12s" },
      ],
      onOpen: "fn",
    },
  },
  {
    name: "Waiting on a long question",
    props: {
      meta: waiting,
      status: {
        state: "waiting",
        detail: "Should the phone's cache use bun:sqlite through the bridge, or GRDB with its own migrations and a separate write queue?",
        phrase: false,
      },
      parts: [{ key: "elapsed", text: "1m 3s" }],
      onOpen: "fn",
    },
  },
  { name: "Done, cost only", props: { meta: done, status: agentStatus(done), parts: [{ key: "cost", text: "$0.03" }], onOpen: "fn" } },
];
