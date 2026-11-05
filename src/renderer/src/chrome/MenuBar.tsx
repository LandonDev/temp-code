import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MENU_TREE, inAppMenus, type InAppMenu } from "@shared/menuTree";
import { Button } from "../components/ui/button";
import { useAway } from "../lib/away";
import { cn } from "../lib/cn";
import { RowsMenu, type MenuRow } from "./menuRows";
import { ALT, IS_MAC, MOD, SHIFT } from "../lib/platform";

/**
 * The menu bar a browser on /ui shows off macOS, opened by a lone Alt: the
 * native menu's rows (src/shared/menuTree.ts `inAppMenus`), each with its
 * key. A pick goes to the app command map. It is a `menubar`: a lone Alt
 * focuses its first title, Left and Right (Home and End) move between the
 * titles, which share one tab stop, and Escape with no menu open, or Alt
 * again, closes it and gives the focus back to where it was.
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

/** A menu's rows: words and keys, no glyphs, as the native bar; a checkbox
 *  row ticked as `checked` says. */
export function rowsOf(menu: InAppMenu, disabled: ReadonlySet<string>, checked: Readonly<Record<string, boolean>> = {}): MenuRow[] {
  return menu.items.map((item): MenuRow =>
    item.kind === "separator"
      ? { kind: "sep" }
      : {
          kind: "item",
          id: item.id,
          label: item.label,
          ...(item.accelerator ? { shortcut: acceleratorLabel(item.accelerator) } : {}),
          ...(disabled.has(item.id) ? { disabled: true } : {}),
          ...(item.checkbox ? { checked: checked[item.id] === true } : {}),
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
  const away = useAway().enabled;
  const [open, setOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // The title holding the bar's one tab stop, and where the focus was
  // before a lone Alt opened the bar.
  const [focusIndex, setFocusIndex] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    shown.current = open || activeMenu !== null;
  });

  const closeBar = useCallback(() => {
    setActiveMenu(null);
    setOpen(false);
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus();
  }, []);

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
        altPressedAlone = false;
        if (shown.current) {
          closeBar();
          return;
        }
        const active = document.activeElement;
        returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
        setOpen(true);
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
  }, [closeBar]);

  const closeMenu = useCallback(() => setActiveMenu(null), []);

  const titles = (): HTMLElement[] => [...(barRef.current?.querySelectorAll<HTMLElement>("[data-menubar-title]") ?? [])];

  // A lone Alt lands the keyboard on the first title.
  useLayoutEffect(() => {
    if (!open) return;
    setFocusIndex(0);
    barRef.current?.querySelector<HTMLElement>("[data-menubar-title]")?.focus();
  }, [open]);

  const onBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // An open menu's keys bubble here through React's tree: those are the menu's.
    const title = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-menubar-title]") : null;
    if (!title) return;
    const all = titles();
    const at = all.indexOf(title);
    const keys: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 };
    if (event.key in keys) {
      event.preventDefault();
      const next = (keys[event.key] + all.length) % all.length;
      setFocusIndex(next);
      all[next]?.focus();
    } else if (event.key === "Escape" && !activeMenu) {
      event.preventDefault();
      closeBar();
    }
  };

  const handlePick = useCallback(
    (id: string) => {
      closeMenu();
      setOpen(false);
      returnFocus.current = null;
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
      role="menubar"
      aria-label="Menu bar"
      aria-orientation="horizontal"
      onKeyDown={onBarKeyDown}
      className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border bg-sidebar px-2 text-xs"
      data-tauri-drag-region="false"
    >
      {menus.map((menu, index) => {
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
                role="menuitem"
                tabIndex={index === focusIndex ? 0 : -1}
                data-menubar-title
                data-tauri-drag-region="false"
                onMouseEnter={() => {
                  if (activeMenu && activeMenu !== key) setActiveMenu(key);
                }}
                className={cn("h-5 px-2 text-xs font-normal after:absolute after:-inset-y-0.5 after:inset-x-0 after:content-['']", isActive ? "bg-muted text-foreground" : "text-muted-foreground")}
              >
                {key}
              </Button>
            }
            rows={() => rowsOf(menu, off, { toggle_away: away })}
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
