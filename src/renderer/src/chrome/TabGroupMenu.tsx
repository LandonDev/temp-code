import { AppWindow, Palette, SquarePlus, Trash2, Ungroup, X } from "./icons";
import { tidy, type MenuRow } from "./menuRows";

/**
 * A project's or tab group's menu of verbs, pure: Customize… first (the
 * name, logo, colour and mascot live in CustomizeGroupDialog), then the
 * group's own verbs when it is a tab group, then the caller's rows (the
 * new-thread rows on a tab group, the pin, reveal and fleet switches on a
 * rail project). The title bar's group chip and the rail's project rows
 * render it, at the pointer and from the row's ⋯.
 */

export type TabGroupMenuAction = "new-tab" | "new-window" | "close-group" | "ungroup" | "delete-group";

export const CUSTOMIZE = "customize";

export function groupMenuRows({ actions, extra = [] }: { actions: boolean; extra?: readonly MenuRow[] }): MenuRow[] {
  const rows: MenuRow[] = [{ kind: "item", id: CUSTOMIZE, label: "Customize…", icon: Palette }];
  if (actions) {
    rows.push(
      { kind: "sep" },
      { kind: "item", id: "new-tab", label: "New tab in group", icon: SquarePlus },
      { kind: "item", id: "new-window", label: "Move group to new window", icon: AppWindow },
      { kind: "sep" },
      { kind: "item", id: "close-group", label: "Close group", icon: X },
      { kind: "item", id: "ungroup", label: "Ungroup", icon: Ungroup },
      { kind: "sep" },
      { kind: "item", id: "delete-group", label: "Delete group", icon: Trash2, danger: true },
    );
  }
  rows.push({ kind: "sep" }, ...extra);
  return tidy(rows);
}

const ACTIONS: ReadonlySet<string> = new Set(["new-tab", "new-window", "close-group", "ungroup", "delete-group"]);

/** A group verb's id read back, or null for Customize… and the caller's rows. */
export function groupActionOf(id: string): TabGroupMenuAction | null {
  return ACTIONS.has(id) ? (id as TabGroupMenuAction) : null;
}
