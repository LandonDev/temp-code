import { ChevronDown, Folder, FolderOpen, MoreHorizontal, Terminal } from "./icons";
import { useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { basename } from "../lib/fs";
import { prettyCwd, prettyParent } from "../lib/paths";
import { looksLikeProject, sameProjectPath, type RecentProject } from "../lib/recents";
import { shortcutFor } from "../lib/settings";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { RowsMenu, tidy, type MenuRow } from "./menuRows";

type Props = {
  cwd: string;
  recents: RecentProject[];
  projectLogoPath?: string | null;
  enabled?: boolean;
  placement?: "above" | "below";
  className?: string;
  buttonClassName?: string;
  /** Chevron on the trailing edge; flips when the menu is open. */
  chevron?: boolean;
  children?: ReactNode;
  onCwdChange: (path: string) => void;
  onNewTerminal?: () => void;
  /** Shows "Choose folder…": the caller opens the folder dialog and hands the
   *  path to `onCwdChange`. */
  onChooseFolder?: () => void;
  /** The menu closed: the caller takes the focus back (the composer). */
  onClose?: () => void;
};

/** Recent projects shown at the top level; the rest sit under More projects. */
const PREVIEW = 5;
const CURRENT = "current";
const NEW_TERMINAL = "new-terminal";
const CHOOSE_FOLDER = "choose-folder";

const folderRow = (path: string): MenuRow => ({
  kind: "item",
  id: `recent:${path}`,
  label: basename(path),
  description: prettyParent(path),
  icon: Folder,
  checked: false,
});

/** The project of a draft (the composer's foot, the title bar): the current
 *  one ticked, recent ones to switch to, the rest under More projects. */
export function CwdPicker({
  cwd,
  recents,
  projectLogoPath,
  enabled = true,
  placement = "above",
  className,
  buttonClassName,
  chevron = false,
  children,
  onCwdChange,
  onNewTerminal,
  onChooseFolder,
  onClose,
}: Props) {
  const [open, setOpen] = useState(false);
  const inProject = looksLikeProject(cwd);
  const label = prettyCwd(cwd);

  const rows = (): MenuRow[] => {
    const others = recents.filter((item) => !inProject || !sameProjectPath(item.path, cwd));
    const preview = others.slice(0, PREVIEW);
    const overflow = others.slice(PREVIEW);
    return tidy([
      ...(inProject
        ? ([
            { kind: "label", label: "Current project" },
            { kind: "item", id: CURRENT, label: basename(cwd), description: prettyParent(cwd), icon: FolderOpen, checked: true },
          ] as const)
        : []),
      ...(preview.length ? [{ kind: "label", label: "Recent projects" } as const, ...preview.map((item) => folderRow(item.path))] : []),
      ...(overflow.length
        ? [{ kind: "sub", id: "more", label: "More projects", icon: MoreHorizontal, items: overflow.map((item) => folderRow(item.path)) } as const]
        : []),
      ...(onChooseFolder ? [{ kind: "item", id: CHOOSE_FOLDER, label: "Choose folder…", icon: FolderOpen } as const] : []),
      { kind: "sep" },
      ...(onNewTerminal
        ? [{ kind: "item", id: NEW_TERMINAL, label: "New terminal", icon: Terminal, shortcut: shortcutFor("Terminal", "New") } as const]
        : []),
    ]);
  };

  const pick = (id: string) => {
    if (id === NEW_TERMINAL) onNewTerminal?.();
    else if (id === CHOOSE_FOLDER) onChooseFolder?.();
    else if (id.startsWith("recent:")) onCwdChange(id.slice("recent:".length));
  };

  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      aria-label={`Project ${label}`}
      disabled={!enabled}
      data-tauri-drag-region="false"
      className={
        buttonClassName
          ? cn("justify-start rounded-none", buttonClassName)
          : "min-w-0 font-normal text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
      }
    >
      {children ?? (
        <>
          <ProjectLogoIcon path={projectLogoPath} fallbackStrokeWidth={1.75} />
          <span className="truncate font-mono text-[12px]">{label}</span>
        </>
      )}
      {chevron ? (
        <ChevronDown
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none", open && "rotate-180")}
          strokeWidth={1.75}
        />
      ) : null}
    </Button>
  );

  return (
    <div className={cn("relative flex h-full min-w-0", className)}>
      <RowsMenu
        trigger={trigger}
        label="Project picker"
        rows={rows}
        onPick={pick}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onClose?.();
        }}
        finalFocus={onClose ? false : undefined}
        side={placement === "below" ? "bottom" : "top"}
        align="start"
        className="w-72"
      />
    </div>
  );
}
