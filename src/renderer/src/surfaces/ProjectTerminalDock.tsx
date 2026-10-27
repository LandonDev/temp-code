import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Globe,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Plus,
} from "../chrome/icons";
import { useRef, useState } from "react";
import { DockFrame } from "../chrome/DockFrame";
import { ExplorerMenu } from "../chrome/ExplorerMenu";
import { SurfaceTabs } from "../chrome/SurfaceTabs";
import { IconButton } from "../chrome/TitleBar";
import { devPane } from "../lib/devPane";
import type { DockSide, ProjectTerminalDock } from "../lib/projectTerminal";
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
  /** Gone once the dock is bottom only (area A24). */
  onSideChange?: (side: DockSide) => void;
  onSizePaint: (size: number) => void;
  onSizeCommit: (size: number) => void;
  onAddTerminal: () => void;
  onSelectTerminal: (fileId: string) => void;
  onCloseTerminal: (fileId: string) => void;
  onReorderTerminals: (ids: string[]) => void;
  onTerminalMetaChange?: (fileId: string, patch: TerminalMetaPatch) => void;
};

const SIDE_ITEMS: { id: DockSide; label: string }[] = [
  { id: "bottom", label: "Dock Bottom" },
  { id: "top", label: "Dock Top" },
  { id: "left", label: "Dock Left" },
  { id: "right", label: "Dock Right" },
];

function sideIcon(side: DockSide) {
  if (side === "top") return PanelTop;
  if (side === "left") return PanelLeft;
  if (side === "right") return PanelRight;
  return PanelBottom;
}

function hideIcon(side: DockSide) {
  if (side === "top") return ChevronUp;
  if (side === "left") return ChevronLeft;
  if (side === "right") return ChevronRight;
  return ChevronDown;
}

export function ProjectTerminalDock({
  dock,
  focused,
  onFocus,
  onHide,
  onSideChange,
  onSizePaint,
  onSizeCommit,
  onAddTerminal,
  onSelectTerminal,
  onCloseTerminal,
  onReorderTerminals,
  onTerminalMetaChange,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sideButton = useRef<HTMLDivElement>(null);
  const SideIcon = sideIcon(dock.side);
  const HideIcon = hideIcon(dock.side);

  return (
    <DockFrame
      data-project-terminal-dock=""
      side={dock.side}
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
            <div ref={sideButton}>
            <IconButton
              label="Move Terminal"
              onClick={() => {
                const rect = sideButton.current?.getBoundingClientRect();
                if (!rect) return;
                setMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
            >
              <SideIcon className="size-3.5" strokeWidth={1.75} />
            </IconButton>
            </div>
            <IconButton
              label={`Hide Terminal (${MOD}J)`}
              onClick={onHide}
            >
              <HideIcon className="size-3.5" strokeWidth={1.75} />
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
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="Move terminal"
          items={SIDE_ITEMS.map((item) => ({
            kind: "item" as const,
            id: item.id,
            label: item.label,
            checked: item.id === dock.side,
          }))}
          onPick={(id) => {
            if (id === "top" || id === "bottom" || id === "left" || id === "right") {
              onSideChange?.(id);
            }
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </DockFrame>
  );
}

const EMPTY_IDS = new Set<string>();
const EMPTY_ERRORS = new Map<string, number>();
