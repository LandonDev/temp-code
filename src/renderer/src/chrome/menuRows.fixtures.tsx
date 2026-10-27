// A menu's look, for `bun run ui:preview src/renderer/src/chrome/menuRows.fixtures.tsx#MenuSketch`.
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Archive, Laptop, Layers, Pause, Pencil, Server, Square, Target, Trash2 } from "./icons";
import { MenuRows } from "./menuBody";
import type { MenuRow } from "./menuRows";

/** A working thread's rows, open under its ⋯ trigger. */
const WORKING: MenuRow[] = [
  { kind: "note", id: "line", content: <><Laptop className="size-3" strokeWidth={1.5} /><span>This Mac</span><span className="ms-auto tabular-nums">$1.42</span></> },
  { kind: "sep" },
  { kind: "item", id: "rename", label: "Rename", icon: Pencil },
  { kind: "sub", id: "type", label: "Type", icon: Layers, items: [] },
  { kind: "item", id: "goal", label: "Goal…", icon: Target, checked: false },
  { kind: "sep" },
  { kind: "item", id: "pause", label: "Pause", icon: Pause },
  { kind: "item", id: "stop", label: "Stop", icon: Square, danger: true },
  { kind: "sep" },
  { kind: "item", id: "move", label: "Move to box…", icon: Server, disabled: true, description: "The box is offline" },
  { kind: "sep" },
  { kind: "item", id: "archive", label: "Archive", icon: Archive, hint: "2 resources" },
  { kind: "item", id: "delete", label: "Delete…", icon: Trash2, danger: true },
];

export function MenuSketch({ rows = WORKING }: { rows?: MenuRow[] }) {
  return (
    <div style={{ height: 420 }}>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>⋯</DropdownMenuTrigger>
        <DropdownMenuContent size="sm" align="start" className="w-60" aria-label="Thread menu">
          <MenuRows kind="dropdown" items={rows} onPick={() => {}} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default [{ name: "A working thread's rows", props: {} }];
