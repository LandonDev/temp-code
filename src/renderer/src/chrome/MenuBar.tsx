import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MENU_TREE, inAppMenus, type InAppMenu } from "@shared/menuTree";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { RowsMenu, type MenuRow } from "./menuRows";
import { ALT, IS_MAC, MOD, SHIFT } from "../lib/platform";

/**
 * The menu bar a browser on /ui shows off macOS, opened by a lone Alt: the
 * native menu's rows (src/shared/menuTree.ts `inAppMenus`), each with its
 * key. A pick goes to the app command map.
 */

const KEY_NAMES: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓", Plus: "+" };

/** `CmdOrCtrl+Shift+F` as the platform writes it: ⌘⇧F on a Mac, Ctrl+Shift+F elsewhere. */
export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((part) => {
    if (part === "CmdOrCtrl" || part === "CommandOrControl" || part === "Cmd") return MOD;
    if (part === "Ctrl") return IS_MAC ? "⌃" : "Ctrl+";
    if (part === "Shift") return SHIFT;
    if (part === "Alt" || part === "Option") return ALT;
    return `${part}+`;
  });
  return mods.join("") + (KEY_NAMES[key] ?? key);
}

/** A menu's rows: words and keys, no glyphs, as the native bar. */
function rowsOf(menu: InAppMenu, disabled: ReadonlySet<string>): MenuRow[] {
  return menu.items.map((item): MenuRow =>
    item.kind === "separator"
      ? { kind: "sep" }
      : {
          kind: "item",
          id: item.id,
          label: item.label,
          ...(item.accelerator ? { shortcut: acceleratorLabel(item.accelerator) } : {}),
          ...(disabled.has(item.id) ? { disabled: true } : {}),
        },
  );
}

type Props = {
  onCommand: (id: string) => void;
  /** Rows that would do nothing here, greyed. */
  disabled?: readonly string[];
};

export function MenuBar({ onCommand, disabled }: Props) {
  const menus = useMemo(() => inAppMenus(MENU_TREE), []);
  const off = useMemo(() => new Set(disabled ?? []), [disabled]);
  const [open, setOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Toggle with standalone Alt key tap
  useEffect(() => {
    let altPressedAlone = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        altPressedAlone = true;
      } else if (altPressedAlone) {
        altPressedAlone = false;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altPressedAlone) {
        setOpen((prev) => {
          if (prev) {
            setActiveMenu(null);
            return false;
          }
          return true;
        });
        altPressedAlone = false;
      }
    };

    const onBlur = () => {
      altPressedAlone = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const closeMenu = useCallback(() => setActiveMenu(null), []);

  const handlePick = useCallback(
    (id: string) => {
      closeMenu();
      setOpen(false);
      onCommand(id);
    },
    [closeMenu, onCommand],
  );

  if (!open && !activeMenu) {
    return null;
  }

  return (
    <div
      ref={barRef}
      className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border bg-sidebar px-2 text-[12px]"
      data-tauri-drag-region="false"
    >
      {menus.map((menu) => {
        const key = menu.label;
        const isActive = activeMenu === key;
        return (
          <RowsMenu
            key={key}
            label={`${key} menu`}
            open={isActive}
            modal={false}
            align="start"
            trigger={
              <Button
                variant="ghost"
                size="xs"
                data-tauri-drag-region="false"
                onMouseEnter={() => {
                  if (activeMenu && activeMenu !== key) setActiveMenu(key);
                }}
                className={cn("h-5 px-2 text-[12px] font-normal", isActive ? "bg-muted text-foreground" : "text-muted-foreground")}
              >
                {key}
              </Button>
            }
            rows={() => rowsOf(menu, off)}
            onPick={handlePick}
            onOpenChange={(next) => {
              if (next) setActiveMenu(key);
              else if (activeMenu === key) closeMenu();
            }}
          />
        );
      })}
    </div>
  );
}
