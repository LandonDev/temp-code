import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MENU_TREE, inAppMenus, type InAppMenu } from "@shared/menuTree";
import { ExplorerMenu, type ExplorerMenuItem } from "./ExplorerMenu";
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

function rowsOf(menu: InAppMenu, disabled: ReadonlySet<string>): ExplorerMenuItem[] {
  return menu.items.map((item): ExplorerMenuItem =>
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
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
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
            setMenuAnchor(null);
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

  const openDropdown = useCallback((key: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setActiveMenu(key);
    setMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  const closeMenu = useCallback(() => {
    setActiveMenu(null);
    setMenuAnchor(null);
  }, []);

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
      className="flex h-7 shrink-0 items-center gap-0.5 border-b border-content/10 bg-content/5 px-2 text-[12px]"
      data-tauri-drag-region="false"
    >
      {menus.map(({ label }) => {
        const key = label;
        const isActive = activeMenu === key;
        return (
          <button
            key={key}
            type="button"
            data-tauri-drag-region="false"
            onClick={(e) => {
              if (isActive) {
                closeMenu();
              } else {
                openDropdown(key, e.currentTarget);
              }
            }}
            onMouseEnter={(e) => {
              if (activeMenu && activeMenu !== key) {
                openDropdown(key, e.currentTarget);
              }
            }}
            className={`pressable rounded-md px-2 py-0.5 transition-colors ${
              isActive
                ? "bg-content/10 text-content"
                : "text-content/70 hover:bg-content/5 hover:text-content"
            }`}
          >
            {label}
          </button>
        );
      })}

      {activeMenu && menuAnchor ? (
        <ExplorerMenu
          x={menuAnchor.x}
          y={menuAnchor.y}
          items={rowsOf(menus.find((m) => m.label === activeMenu)!, off)}
          ariaLabel={`${activeMenu} menu`}
          onPick={handlePick}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}
