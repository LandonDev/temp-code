import { DockBar } from "../chrome/DockBar";
import { DockFrame } from "../chrome/DockFrame";
import { devPane } from "../lib/devPane";
import { useDevTab } from "../lib/devServers";
import type { ProjectTerminalDock } from "../lib/projectTerminal";
import type { TerminalMetaPatch } from "../lib/terminalTab";
import { terminalChunk } from "./chunks";
import { SurfaceSkeleton } from "./SurfaceSkeleton";

// xterm lives in the terminal chunk (surfaces/chunks.ts); the first dock tab pulls it in.
const TerminalView = terminalChunk.surface("TerminalView", <SurfaceSkeleton kind="terminal" label="Loading terminal" />);

type Props = {
  dock: ProjectTerminalDock;
  focused: boolean;
  onFocus: () => void;
  onHide: () => void;
  onSizePaint: (size: number) => void;
  onSizeCommit: (size: number) => void;
  onAddTerminal: () => void;
  onSelectTerminal: (fileId: string) => void;
  onCloseTerminal: (fileId: string) => void;
  onReorderTerminals: (ids: string[]) => void;
  onTerminalMetaChange?: (fileId: string, patch: TerminalMetaPatch) => void;
};

/** The bottom dock showing a project's terminals; its bar's Dev servers tab opens the other occupant. */
export function ProjectTerminalDock({
  dock,
  focused,
  onFocus,
  onHide,
  onSizePaint,
  onSizeCommit,
  onAddTerminal,
  onSelectTerminal,
  onCloseTerminal,
  onReorderTerminals,
  onTerminalMetaChange,
}: Props) {
  const dev = useDevTab(dock.projectPath);

  return (
    <DockFrame
      data-project-terminal-dock=""
      size={dock.size}
      focused={focused}
      label="Resize terminal"
      onFocus={onFocus}
      onSizePaint={onSizePaint}
      onSizeCommit={(size) => {
        onSizeCommit(size);
        devPane.size(size);
      }}
    >
      <DockBar
        terminals={dock.pane.files}
        active={dock.pane.activeFileId}
        dev={dev}
        onSelect={onSelectTerminal}
        onSelectDev={() => devPane.open()}
        onClose={onCloseTerminal}
        onReorder={onReorderTerminals}
        onAdd={onAddTerminal}
        onHide={onHide}
      />
      <div className="relative min-h-0 min-w-0 flex-1">
        {dock.pane.files.map((file) => (
          <div
            key={file.id}
            aria-hidden={file.id !== dock.pane.activeFileId}
            className={
              file.id === dock.pane.activeFileId
                ? "absolute inset-0 h-full"
                : "hidden"
            }
          >
            <TerminalView
              id={file.id}
              cwd={file.cwd}
              active={focused && file.id === dock.pane.activeFileId}
              onMetaChange={(patch) => onTerminalMetaChange?.(file.id, patch)}
            />
          </div>
        ))}
      </div>
    </DockFrame>
  );
}
