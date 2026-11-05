// Fixtures for `bun run ui:preview src/renderer/src/chrome/DockFrame.tsx#DockFrame`: the dock's
// frame (its top sash and hairline) around a bar, as the terminal and dev servers panes draw it.
import { DockBar } from "./DockBar";
import { newTerminalFile } from "../lib/layout";

const files = [
  { ...newTerminalFile("/srv/agents/work/temp-code", "zsh"), id: "a" },
  { ...newTerminalFile("/srv/agents/work/temp-code", "bun run gate"), id: "b" },
];
const noop = () => {};
const bar = <DockBar terminals={files} active="a" dev={{ count: 2 }} onSelect={noop} onSelectDev={noop} onAdd={noop} onHide={noop} />;

export default [
  { name: "the terminal dock, not focused", props: { size: 200, focused: false, label: "Resize terminal", onFocus: "fn", onSizePaint: "fn", onSizeCommit: "fn", children: bar } },
  { name: "focused", props: { size: 200, focused: true, label: "Resize terminal", onFocus: "fn", onSizePaint: "fn", onSizeCommit: "fn", children: bar } },
];
