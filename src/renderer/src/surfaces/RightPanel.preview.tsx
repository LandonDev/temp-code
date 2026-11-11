// A preview frame for `bun run ui:preview src/renderer/src/surfaces/RightPanel.preview.tsx#PanelHeaderPreview`:
// the panel's header at a width, under a 40px stand-in for the title bar's row so both lines show.
import { PanelHeader } from "./RightPanel";
import type { Section } from "../lib/rightPanel";

export function PanelHeaderPreview({ width, sections, value }: { width: number; sections: Section[]; value: Section }) {
  return (
    <div className="flex flex-col" style={{ width }}>
      <div className="h-10 border-b border-border" />
      <div className="flex h-40 flex-col border-l border-border bg-sidebar">
        <PanelHeader sections={sections} value={value} onChange={() => {}} onClose={() => {}} width={width} />
      </div>
    </div>
  );
}
