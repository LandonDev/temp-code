import type { ExplorerMenuItem } from "../../../chrome/ExplorerMenu";
import { chipMenuItems } from "../../../chrome/ThreadHeader";
import type { StripChip } from "../../../chrome/ThreadHeaderStrip";
import type { SessionMeta } from "../../../lib/tcserver/types";
import type { MoveTarget } from "../../../lib/threadMove";

/**
 * A board row's right-click menu (docs/LAYOUT.md "Master"), and the same
 * for a subagent line under it: New pass… first, Open, then the thread's
 * own menu as its tab has it (`chipMenuItems`: rename, continue, pause,
 * compact, stop, the master pin, archive) with the host moves the thread
 * chip offers before Archive. The tab's dialogs that do not belong on a
 * board (the type's options, the Mac bridge, resources, delete) stay on
 * the tab.
 */

/** The ids the board answers; the rest of the tab's menu stays on the tab. */
const BOARD_IDS = new Set(["rename", "resume", "pause", "compact", "killBackground", "stop", "master", "archive"]);

export function rowMenuItems(meta: SessionMeta, master: boolean, moves: readonly MoveTarget[]): ExplorerMenuItem[] {
  const chip = { id: meta.id, thread: meta, status: meta.status } as unknown as StripChip;
  const own = chipMenuItems(chip, undefined, 0, master).filter((item) => item.kind === "sep" || BOARD_IDS.has(item.id));
  const archive = own.findIndex((item) => item.kind === "item" && item.id === "archive");
  const moveRows: ExplorerMenuItem[] = moves.flatMap((t): ExplorerMenuItem[] => [
    { kind: "item", id: `move:${t.environmentId}`, label: `Move to ${t.name}…`, disabled: !t.ok },
    ...(t.ok ? [] : [{ kind: "item", id: `why:${t.environmentId}`, label: t.reason, disabled: true } as const]),
  ]);
  const body = archive < 0 ? [...own, { kind: "sep" } as const, ...moveRows] : [...own.slice(0, archive), ...moveRows, { kind: "sep" } as const, ...own.slice(archive)];
  return tidy([
    { kind: "item", id: "new-pass", label: "New pass…" },
    { kind: "item", id: "open", label: "Open" },
    { kind: "sep" },
    ...body,
  ]);
}

/** No separator first, last or twice in a row. */
function tidy(items: ExplorerMenuItem[]): ExplorerMenuItem[] {
  const out: ExplorerMenuItem[] = [];
  for (const item of items) {
    if (item.kind === "sep" && (out.length === 0 || out[out.length - 1]?.kind === "sep")) continue;
    out.push(item);
  }
  while (out[out.length - 1]?.kind === "sep") out.pop();
  return out;
}
