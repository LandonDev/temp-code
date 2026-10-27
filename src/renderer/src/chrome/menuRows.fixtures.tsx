// A menu's look, for `bun run ui:preview src/renderer/src/chrome/menuRows.fixtures.tsx#MenuSketch`.
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { threadMenuRows } from "../lib/threadMenu";
import { Laptop, Server } from "./icons";
import { MenuRows } from "./menuBody";
import type { MenuRow } from "./menuRows";

/** A working thread's rows (lib/threadMenu.ts), open under its ⋯ trigger. */
const WORKING: MenuRow[] = [
  { kind: "note", id: "line", content: <><Laptop className="size-3" strokeWidth={1.5} /><span>This Mac</span><span className="ms-auto tabular-nums">$1.42</span></> },
  { kind: "sep" },
  ...threadMenuRows({
    status: "running",
    threadType: "implementation",
    projectId: "p1",
    parentId: null,
    master: false,
    resources: 2,
    goal: false,
    side: true,
    moves: [{ kind: "item", id: "move:box", label: "Move to box…", icon: Server, disabled: true, description: "The thread is working" }],
  }),
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
