// A preview page for `bun run ui:preview
// src/renderer/src/surfaces/threads/computer/ComputerView.preview.tsx#ComputerStates --props '{"from":0,"to":6}'`:
// every fixture of the Computer section in a panel 260px and 480px wide, on the
// sidebar fill under the panel's own header, as the right panel draws it.
// Rendered by nothing in the app.
import { PanelHeader } from "../../RightPanel";
import { ComputerView } from "./ComputerView";
import fixtures from "./ComputerView.fixtures";

const SECTIONS = ["agents", "activity", "computer", "changes", "notes", "files", "build"] as const;
const noop = (): void => {};

export function ComputerStates({ from = 0, to = fixtures.length, only, height = 560 }: { from?: number; to?: number; /** these entries alone, by their place in the list */ only?: number[]; height?: number }) {
  const shown = only ? only.map((i) => fixtures[i]).filter(Boolean) : fixtures.slice(from, to);
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((fixture) => (
        <figure key={fixture.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{fixture.name}</figcaption>
          <div className="flex items-start gap-6">
            {(fixture.widths ?? [260, 480]).map((width) => (
              <div key={width} className="flex shrink-0 flex-col border-x border-border bg-sidebar" style={{ width, height: fixture.height ?? height }}>
                <PanelHeader sections={SECTIONS} value="computer" onChange={noop} onClose={noop} width={width} />
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ComputerView
                    {...fixture.props}
                    viewport={fixture.kept?.[width] && fixture.props.viewport ? { ...fixture.props.viewport, height: fixture.kept[width] } : fixture.props.viewport}
                  />
                </div>
              </div>
            ))}
          </div>
        </figure>
      ))}
    </div>
  );
}
