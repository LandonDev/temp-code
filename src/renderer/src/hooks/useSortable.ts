import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { animate } from "motion/react";
import { pushSample, releaseVelocity, setGrabbing, suppressTextSelection, type DragSample } from "../lib/drag";
import { SPRING_GLIDE } from "../lib/ease";
import { moveItem } from "../lib/reorder";

const THRESHOLD = 5;
const DROP_ON_INSET = 0.25;

export type SortableDropTarget = {
  kind: "tab" | "group";
  id: string;
  /** False when the drop is refused — the target is flagged, not acted on. */
  allowed: boolean;
};

export type SortableOptions = {
  axis?: "x" | "y";
  /** Called once the pointer crosses the drag threshold. */
  onActivate?: (id: string) => void;
  onDropOnItem?: (draggedId: string, targetId: string) => void;
  onDropOnGroup?: (draggedId: string, groupId: string) => void;
  canDropOn?: (
    draggedId: string,
    kind: "tab" | "group",
    targetId: string,
  ) => boolean;
};

type DragState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  toIndex: number;
  dropTarget: SortableDropTarget | null;
  /** The dragged row's offset on the axis from where it was grabbed. */
  offset: number;
  /** The offset it is drawn at: none under reduced motion, where it does not follow. */
  drawn: number;
  samples: DragSample[];
};

/** A reorder just dropped: the row stays where the pointer left it until the
 *  list renders in its new order, then glides from there into its slot. */
type PendingDrop = { id: string; order: string; from: number; velocity: number };

const reduceMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const orderOf = (ids: readonly string[]) => ids.join("\u0000");

function optionsOf(
  axisOrOptions: "x" | "y" | SortableOptions | undefined,
): SortableOptions {
  if (axisOrOptions == null) return { axis: "x" };
  if (axisOrOptions === "x" || axisOrOptions === "y") return { axis: axisOrOptions };
  return { axis: "x", ...axisOrOptions };
}

/**
 * Pointer reordering for a list of rows. The grabbed row follows the pointer
 * on the list's axis from where it was grabbed, written straight to its node so
 * a move re-renders nothing but the insertion line; the other rows hold still.
 * On release the row glides home on SPRING_GLIDE carrying the pointer's speed:
 * into its new slot once the list renders in the new order (a FLIP of that one
 * row), or back to its own when the drop changes nothing or Escape cancels it.
 * Reduced motion: no follow, the line alone, the drop at once.
 */
export function useSortable(
  ids: string[],
  onReorder: (ids: string[], movedId?: string) => void,
  axisOrOptions: "x" | "y" | SortableOptions = "x",
) {
  const options = optionsOf(axisOrOptions);
  const axis = options.axis ?? "x";
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onDropOnItemRef = useRef(options.onDropOnItem);
  onDropOnItemRef.current = options.onDropOnItem;
  const onDropOnGroupRef = useRef(options.onDropOnGroup);
  onDropOnGroupRef.current = options.onDropOnGroup;
  const onActivateRef = useRef(options.onActivate);
  onActivateRef.current = options.onActivate;
  const canDropOnRef = useRef(options.canDropOn);
  canDropOnRef.current = options.canDropOn;
  const nodes = useRef(new Map<string, HTMLElement>());
  const groupNodes = useRef(new Map<string, HTMLElement>());
  const drag = useRef<DragState | null>(null);
  const suppressClickUntil = useRef(0);

  const pending = useRef<PendingDrop | null>(null);
  const glides = useRef(new Map<string, { stop: () => void }>());

  const place = useCallback((el: HTMLElement, offset: number) => {
    el.style.translate = offset === 0 ? "" : axis === "x" ? `${offset}px 0px` : `0px ${offset}px`;
  }, [axis]);

  /** Glide a row's offset from `from` to its slot, carrying `velocity` px/s. */
  const glideHome = useCallback(
    (id: string, from: number, velocity: number) => {
      const el = nodes.current.get(id);
      glides.current.get(id)?.stop();
      glides.current.delete(id);
      if (!el) return;
      if (Math.abs(from) < 0.5 || reduceMotion()) {
        place(el, 0);
        return;
      }
      place(el, from);
      const glide = animate(from, 0, {
        ...SPRING_GLIDE,
        velocity,
        onUpdate: (value) => place(el, value),
        onComplete: () => {
          place(el, 0);
          glides.current.delete(id);
        },
      });
      glides.current.set(id, glide);
    },
    [place],
  );

  // After a reorder commits, the dropped row is in its new slot but still
  // drawn where the pointer left it: measure the slot and glide from there.
  useLayoutEffect(() => {
    const drop = pending.current;
    if (!drop || orderOf(ids) === drop.order) return;
    pending.current = null;
    const el = nodes.current.get(drop.id);
    // A row the list no longer mounts (a virtual list scrolled away) has nothing to glide.
    if (!el) return;
    place(el, 0);
    const slot = el.getBoundingClientRect();
    glideHome(drop.id, drop.from - (axis === "x" ? slot.left : slot.top), drop.velocity);
  });

  // A reorder the parent never renders (it refused it) leaves the row where it
  // was dropped: after a beat it glides back to its own slot.
  useEffect(() => {
    if (!pending.current) return;
    const timer = window.setTimeout(() => {
      const drop = pending.current;
      if (!drop) return;
      pending.current = null;
      const el = nodes.current.get(drop.id);
      if (!el) return;
      const offset = parseFloat((el.style.translate || "0px 0px").split(" ")[axis === "x" ? 0 : 1] ?? "0");
      glideHome(drop.id, offset, 0);
    }, 300);
    return () => window.clearTimeout(timer);
  });

  useEffect(() => {
    const running = glides.current;
    return () => {
      for (const glide of running.values()) glide.stop();
    };
  }, []);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [toIndex, setToIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<SortableDropTarget | null>(null);

  const setItemRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);

  const setGroupDropRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) groupNodes.current.set(id, el);
    else groupNodes.current.delete(id);
  }, []);

  const indexAt = useCallback(
    (x: number, y: number) => {
      const list = idsRef.current;
      const pos = axis === "x" ? x : y;
      let next = list.length - 1;
      for (let i = 0; i < list.length; i++) {
        const rect = nodes.current.get(list[i])?.getBoundingClientRect();
        if (!rect) continue;
        // The dragged row is drawn under the pointer; its slot is where it was.
        const shift = drag.current?.id === list[i] ? drag.current.drawn : 0;
        const mid =
          (axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2) - shift;
        if (pos < mid) {
          next = i;
          break;
        }
      }
      return next;
    },
    [axis],
  );

  const dropTargetAt = useCallback(
    (draggedId: string, x: number, y: number): SortableDropTarget | null => {
      const target = (
        kind: "tab" | "group",
        id: string,
      ): SortableDropTarget => ({
        kind,
        id,
        allowed: canDropOnRef.current?.(draggedId, kind, id) ?? true,
      });
      for (const [groupId, el] of groupNodes.current) {
        const rect = el.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return target("group", groupId);
        }
      }
      if (!onDropOnItemRef.current) return null;
      for (const id of idsRef.current) {
        if (id === draggedId) continue;
        const rect = nodes.current.get(id)?.getBoundingClientRect();
        if (!rect) continue;
        const inset =
          axis === "x" ? rect.width * DROP_ON_INSET : rect.height * DROP_ON_INSET;
        const inCenter =
          axis === "x"
            ? x >= rect.left + inset &&
              x <= rect.right - inset &&
              y >= rect.top &&
              y <= rect.bottom
            : y >= rect.top + inset &&
              y <= rect.bottom - inset &&
              x >= rect.left &&
              x <= rect.right;
        if (inCenter) return target("tab", id);
      }
      return null;
    },
    [axis],
  );

  const onItemPointerDown = useCallback(
    (id: string, event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      if (idsRef.current.length < 2) return;
      if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
        return;
      }
      const handle = event.currentTarget as HTMLElement;
      const from = idsRef.current.indexOf(id);
      if (from < 0) return;

      const state: DragState = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        toIndex: from,
        dropTarget: null,
        offset: 0,
        drawn: 0,
        samples: [],
      };
      // A row caught mid-glide stops where it is drawn.
      glides.current.get(id)?.stop();
      glides.current.delete(id);
      // The row that moves is the registered node; the press may land on a part of it.
      const row = nodes.current.get(id) ?? handle;
      const grabbed = parseFloat((row.style.translate || "0px 0px").split(" ")[axis === "x" ? 0 : 1] ?? "0") || 0;
      const follows = !reduceMotion();
      drag.current = state;
      handle.setPointerCapture(event.pointerId);
      // A press is a click until it moves: only a drag turns selection off
      // for the whole document (a class on <html>, a restyle of everything),
      // so a click on a rail row or a tab never pays for it. Until then a
      // move under the threshold starts no selection.
      const blockSelect = (ev: Event) => ev.preventDefault();
      window.addEventListener("selectstart", blockSelect);
      let restoreSelection: (() => void) | null = null;

      const onMove = (ev: PointerEvent) => {
        const current = drag.current;
        if (!current || current.id !== id) return;
        if (!current.active) {
          if (
            Math.hypot(ev.clientX - current.startX, ev.clientY - current.startY) <
            THRESHOLD
          ) {
            return;
          }
          current.active = true;
          restoreSelection = suppressTextSelection();
          setGrabbing(true);
          setDraggingId(id);
          setToIndex(from);
          onActivateRef.current?.(id);
        }
        const along = axis === "x" ? ev.clientX - current.startX : ev.clientY - current.startY;
        current.offset = grabbed + along;
        pushSample(current.samples, axis === "x" ? ev.clientX : ev.clientY, ev.timeStamp);
        if (follows) {
          current.drawn = current.offset;
          place(row, current.offset);
        }
        const dropOn = dropTargetAt(id, ev.clientX, ev.clientY);
        const next = indexAt(ev.clientX, ev.clientY);
        if (
          next === current.toIndex &&
          current.dropTarget?.kind === dropOn?.kind &&
          current.dropTarget?.id === dropOn?.id &&
          current.dropTarget?.allowed === dropOn?.allowed
        ) {
          return;
        }
        current.toIndex = next;
        current.dropTarget = dropOn;
        setToIndex(next);
        setDropTarget(dropOn);
      };

      const onUp = (ev: PointerEvent) => stop(true, ev.timeStamp);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          stop(false);
        }
      };

      function stop(commit: boolean, now = Infinity) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey);
        const current = drag.current;
        drag.current = null;
        window.removeEventListener("selectstart", blockSelect);
        restoreSelection?.();
        setGrabbing(false);
        setDraggingId(null);
        setToIndex(null);
        setDropTarget(null);
        try {
          handle.releasePointerCapture(state.pointerId);
        } catch {
          /* already released */
        }
        if (!current?.active) {
          place(row, 0);
          return;
        }
        const velocity = releaseVelocity(current.samples, now);
        if (!commit) {
          glideHome(current.id, current.offset, 0);
          return;
        }
        suppressClickUntil.current = performance.now() + 400;
        if (current.dropTarget) {
          // The row joins another (a group, a tab): it leaves its place, so nothing glides.
          place(row, 0);
          // A refused target still swallows the drop: the tab stays put rather
          // than reordering into a group it cannot join.
          if (!current.dropTarget.allowed) return;
          if (current.dropTarget.kind === "tab") {
            onDropOnItemRef.current?.(current.id, current.dropTarget.id);
          } else {
            onDropOnGroupRef.current?.(current.id, current.dropTarget.id);
          }
          return;
        }
        const list = idsRef.current;
        const fromIndex = list.indexOf(current.id);
        if (fromIndex >= 0 && current.toIndex !== fromIndex) {
          const rect = row.getBoundingClientRect();
          pending.current = {
            id: current.id,
            order: orderOf(list),
            from: axis === "x" ? rect.left : rect.top,
            velocity,
          };
          onReorderRef.current(moveItem(list, fromIndex, current.toIndex), current.id);
        } else {
          glideHome(current.id, current.offset, velocity);
        }
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey);
    },
    [axis, dropTargetAt, glideHome, indexAt, place],
  );

  const consumeClick = useCallback(
    () => performance.now() < suppressClickUntil.current,
    [],
  );

  return {
    draggingId,
    fromIndex: draggingId ? ids.indexOf(draggingId) : null,
    toIndex: draggingId && !dropTarget ? toIndex : null,
    dropTarget: draggingId ? dropTarget : null,
    setItemRef,
    setGroupDropRef,
    onItemPointerDown,
    consumeClick,
  };
}
