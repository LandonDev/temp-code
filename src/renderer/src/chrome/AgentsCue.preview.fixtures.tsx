// Fixtures for `bun run ui:preview src/renderer/src/chrome/AgentsCue.preview.tsx#AgentsCueEndGroup`:
// the title bar's end group at each state of the agents cue.
import { agentsCue } from "../lib/threads/agents";

export default [
  { name: "No live agents: ⋯ and Panel alone", props: { cue: null } },
  {
    name: "1 working on Claude, the thread watching: the spinner",
    props: { cue: agentsCue({ working: 1, waiting: 0, queued: 0, providers: ["claude"] }, false) },
  },
  {
    name: "3 live on two providers, the thread's own turn running: the still dot",
    props: { cue: agentsCue({ working: 2, waiting: 0, queued: 1, providers: ["claude", "codex"] }, true) },
  },
  {
    name: "6 live on three providers",
    props: { cue: agentsCue({ working: 6, waiting: 0, queued: 0, providers: ["claude", "codex", "muse"] }, false) },
  },
  {
    name: "1 needs you among 4: amber words",
    props: { cue: agentsCue({ working: 2, waiting: 1, queued: 1, providers: ["claude", "codex"] }, true) },
  },
  {
    name: "Muse Code beside a Meta model: one symbol, both named",
    props: { cue: agentsCue({ working: 2, waiting: 0, queued: 0, providers: ["muse", "meta"] }, false) },
  },
  {
    name: "Six providers, Muse Code and Meta one symbol: four marks and +1",
    props: { cue: agentsCue({ working: 6, waiting: 0, queued: 0, providers: ["claude", "codex", "muse", "cursor", "meta", "grok"] }, false) },
  },
  { name: "Queued only", props: { cue: agentsCue({ working: 0, waiting: 0, queued: 2, providers: ["codex"] }, false) } },
  {
    name: "Pressed: the panel is open on Agents",
    props: { cue: agentsCue({ working: 2, waiting: 0, queued: 0, providers: ["claude"] }, false), pressed: true },
  },
  { name: "No room for the panel", props: { cue: agentsCue({ working: 2, waiting: 0, queued: 0, providers: ["claude"] }, false), room: false } },
];
