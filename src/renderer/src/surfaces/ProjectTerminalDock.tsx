import { ChevronDown, Globe, Plus } from "../chrome/icons";
import { DockFrame } from "../chrome/DockFrame";
import { SurfaceTabs } from "../chrome/SurfaceTabs";
import { IconButton } from "../chrome/TitleBar";
import { devPane } from "../lib/devPane";
import type { ProjectTerminalDock } from "../lib/projectTerminal";
import { MOD } from "../lib/platform";
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
  return (
    <DockFrame
      data-project-terminal-dock=""
      size={dock.size}
      focused={focused}
      label="Resize terminal"
      onFocus={onFocus}
      onSizePaint={onSizePaint}
      onSizeCommit={onSizeCommit}
    >
      <SurfaceTabs
        files={dock.pane.files}
        activeFileId={dock.pane.activeFileId}
        dirtyFileIds={EMPTY_IDS}
        fileErrorCounts={EMPTY_ERRORS}
        label="Terminals"
        onSelectFile={onSelectTerminal}
        onCloseFile={onCloseTerminal}
        onReorder={onReorderTerminals}
        trailing={
          <div className="flex shrink-0 items-center gap-0.5 border-l border-content/10 px-2">
            <IconButton
              label={`New Terminal (${MOD}\`)`}
              onClick={onAddTerminal}
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
            </IconButton>
            <IconButton label="Dev Servers" onClick={() => devPane.open()}>
              <Globe className="size-3.5" strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label={`Hide Terminal (${MOD}J)`}
              onClick={onHide}
            >
              <ChevronDown className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </div>
        }
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

const EMPTY_IDS = new Set<string>();
const EMPTY_ERRORS = new Map<string, number>();
