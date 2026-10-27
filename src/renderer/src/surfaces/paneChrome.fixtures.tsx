// Fixtures for `bun run ui:preview src/renderer/src/surfaces/paneChrome.tsx#PaneHeader`,
// and the split itself: `bun run ui:preview src/renderer/src/surfaces/paneChrome.fixtures.tsx#PaneSplitDemo --width 720`.
import type { LayoutSash } from "../lib/layout";
import { PaneDropHint, PaneHeader, Sash } from "./paneChrome";

export default [
  { name: "Focused", props: { title: "Fix the sash's keyboard", focused: true, onClose: "fn", onDragStart: "fn" } },
  { name: "Not focused", props: { title: "Plan B5: pane splitting, drop zones, pane headers and parked tabs", focused: false, onClose: "fn", onDragStart: "fn" } },
];

const noop = () => {};
const SASH: LayoutSash = { splitId: "row", index: 0, dir: "right", sizes: [0.5, 0.5], group: { x: 0, y: 0, w: 1, h: 1 } };

function Body({ lines }: { lines: string[] }) {
  return (
    <div className="flex flex-1 flex-col gap-2 bg-background px-4 py-3 text-[13px] text-muted-foreground">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

/** Two panes at 50/50: the left focused, a pane being dropped on the right one's right half. */
export function PaneSplitDemo() {
  return (
    <div className="relative h-60 w-[720px] overflow-hidden border border-border">
      <div className="absolute inset-y-0 left-0 flex w-1/2 flex-col">
        <PaneHeader title="Fix the sash's keyboard" focused onClose={noop} onDragStart={noop} />
        <Body lines={["Read PaneTree.tsx and the layout helpers.", "Moved the sash into paneChrome.tsx.", "Typecheck passes."]} />
      </div>
      <div className="absolute inset-y-0 right-0 flex w-1/2 flex-col">
        <PaneHeader title="Plan B5: pane splitting" focused={false} onClose={noop} onDragStart={noop} />
        <Body lines={["The drop zone is the half the pane will take."]} />
        <PaneDropHint edge="right" />
      </div>
      <Sash sash={SASH} containerRef={{ current: null }} onPreview={noop} onCommit={noop} onCancel={noop} onEqualize={noop} />
    </div>
  );
}
