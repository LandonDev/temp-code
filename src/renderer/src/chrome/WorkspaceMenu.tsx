import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Popover, type PopoverAnchor } from "./Popover";
import { LAYER } from "../lib/layers";

type Props = {
  anchor: PopoverAnchor;
  onDismiss: () => void;
  onNewProject: () => void;
  onNewChat: () => void;
  /** Absent when the rail that owns the appearance menu is not on screen. */
  onWorkspaceSettings?: () => void;
  onThreadDefaults?: () => void;
  onOrchestration?: () => void;
  onRemoveWorkspace?: () => void;
  canNewProject: boolean;
};

type Item = {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
};

/** The "..." menu on a workspace header. Same look as ExplorerMenu, anchored to an element. */
export function WorkspaceMenu({
  anchor,
  onDismiss,
  onNewProject,
  onNewChat,
  onWorkspaceSettings,
  onThreadDefaults,
  onOrchestration,
  onRemoveWorkspace,
  canNewProject,
}: Props) {
  const groups: Item[][] = [
    [
      {
        id: "new-project",
        label: "New project",
        disabled: !canNewProject,
        run: onNewProject,
      },
      { id: "new-chat", label: "New chat", run: onNewChat },
    ],
    [
      ...(onThreadDefaults
        ? [{ id: "thread-defaults", label: "Thread defaults", run: onThreadDefaults }]
        : []),
      ...(onOrchestration
        ? [{ id: "orchestration", label: "Orchestration", run: onOrchestration }]
        : []),
      ...(onWorkspaceSettings
        ? [{ id: "settings", label: "Workspace settings", run: onWorkspaceSettings }]
        : []),
    ],
    onRemoveWorkspace
      ? [
          {
            id: "remove",
            label: "Remove workspace",
            danger: true,
            run: onRemoveWorkspace,
          },
        ]
      : [],
  ].filter((group) => group.length > 0);
  const items = groups.flat();
  const enabled = items.filter((i) => !i.disabled);
  const [active, setActive] = useState(enabled[0]?.id ?? null);

  const pick = (item: Item) => {
    if (item.disabled) return;
    onDismiss();
    item.run();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const from = enabled.findIndex((i) => i.id === active);
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setActive(
        enabled[(from + dir + enabled.length) % enabled.length]?.id ?? null,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items.find((i) => i.id === active);
      if (item) pick(item);
    }
  };

  return (
    <Popover
      anchor={anchor}
      side="bottom"
      align="end"
      gap={4}
      width={200}
      layer={LAYER.popover}
      autoFocus
      onDismiss={onDismiss}
      role="menu"
      tabIndex={-1}
      aria-label="Workspace actions"
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      className="overflow-y-auto overscroll-none p-1"
    >
      {groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 ? (
            <div role="separator" className="my-1 h-px bg-content/10" />
          ) : null}
          {group.map((item) => {
            const highlighted = item.id === active;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => !item.disabled && setActive(item.id)}
                onClick={() => pick(item)}
                className={`flex h-7 w-full items-center gap-3 rounded-lg px-2 text-left text-[13px] leading-none ${
                  item.disabled
                    ? "text-content/30"
                    : item.danger
                      ? highlighted
                        ? "bg-danger/20 text-danger"
                        : "text-danger hover:bg-danger/15"
                      : highlighted
                        ? "bg-content/10 text-content"
                        : "text-content hover:bg-content/5"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </Popover>
  );
}
