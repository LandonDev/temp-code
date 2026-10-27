// Fixtures for `bun run ui:preview src/renderer/src/chrome/rail/DebugPanel.tsx#DebugView`.
import type { DebugFrame, DebugVariable } from "../../lib/monaco/editorState";

const frames: DebugFrame[] = [
  { id: 1, name: "OrderService.place", line: 118, path: "/repo/src/main/java/OrderService.java" },
  { id: 2, name: "OrderController.post", line: 64, path: "/repo/src/main/java/OrderController.java" },
  { id: 3, name: "Thread.run", line: 829, path: null },
];
const variables: DebugVariable[] = [
  { name: "this", value: "OrderService@4f2a", ref: 9, depth: 0, frameId: 1 },
  { name: "repository", value: "OrderRepository@77c1", ref: 11, depth: 1, frameId: 1 },
  { name: "order", value: "Order{id=1042, items=3}", ref: 12, depth: 0, frameId: 1 },
  { name: "total", value: "129.5", ref: null, depth: 0, frameId: 1 },
];
const output = ["Listening for transport dt_socket at address: 5005", "Started OrderApp in 2.41 seconds", "Placing order 1042"];

const common = {
  frames: [],
  variables: [],
  output: [],
  error: null,
  activeFrameId: null,
  onStep: "fn",
  onStop: "fn",
  onSelectFrame: "fn",
  onExpand: "fn",
  onEvaluate: "fn",
};

export default [
  { name: "No session", props: { ...common, phase: "idle" } },
  { name: "Running", props: { ...common, phase: "running", output: output.slice(0, 2) } },
  { name: "Paused at a breakpoint", props: { ...common, phase: "stopped", frames, variables, output, activeFrameId: 1 } },
  { name: "Failed to attach", props: { ...common, phase: "running", error: "Could not attach to localhost:5005: connection refused" } },
];
