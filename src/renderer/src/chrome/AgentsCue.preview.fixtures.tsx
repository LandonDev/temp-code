// Fixtures for `bun run ui:preview src/renderer/src/chrome/AgentsCue.preview.tsx#AgentsCueEndGroup`:
// the title bar's end group at each state of the agents cue.
import { agentsCue } from "../lib/threads/agents";

export default [
  { name: "No live agents: ⋯ and Panel alone", props: { cue: null } },
  { name: "1 working, the thread watching: the spinner", props: { cue: agentsCue({ working: 1, waiting: 0, queued: 0 }, false) } },
  { name: "4 live, the thread's own turn running: the still dot", props: { cue: agentsCue({ working: 3, waiting: 0, queued: 1 }, true) } },
  { name: "1 needs you among 4: amber", props: { cue: agentsCue({ working: 2, waiting: 1, queued: 1 }, true) } },
  { name: "Queued only", props: { cue: agentsCue({ working: 0, waiting: 0, queued: 2 }, false) } },
  { name: "Pressed: the panel is open on Agents", props: { cue: agentsCue({ working: 2, waiting: 0, queued: 0 }, false), pressed: true } },
  { name: "No room for the panel", props: { cue: agentsCue({ working: 2, waiting: 0, queued: 0 }, false), room: false } },
];
