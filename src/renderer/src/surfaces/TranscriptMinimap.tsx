import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "../lib/session";
import { isErrorBlock } from "../lib/turnOutcome";
import { isEditBlock } from "./editModel";
import { isProseBlock, toolCallLabel } from "./transcriptActivity";

/**
 * A rail of ticks down the transcript's left edge (ported from temp-code):
 * one per row, coloured by who wrote it, with a window for the viewport.
 * Hover a tick for a line of what it says; click to glide there. The window
 * moves by direct DOM writes from the scroll handler, so scrolling never
 * renders.
 */

type TickKind = "user" | "reply" | "edit" | "tool" | "alert";

type Tick = {
  id: string;
  turnId: string;
  kind: TickKind;
  text: string;
};

const TICK: Record<TickKind, { width: number; className: string; who: string }> = {
  user: { width: 14, className: "bg-info", who: "You" },
  reply: { width: 12, className: "bg-content/50", who: "Agent" },
  edit: { width: 12, className: "bg-success/60", who: "Edit" },
  tool: { width: 7, className: "bg-content/20", who: "Tool" },
  alert: { width: 12, className: "bg-warning", who: "Error" },
};

const MIN_RAIL = 48;
const MAX_RAIL = 320;
const ROW_PX = 9;
const MIN_WINDOW = 10;
/** Ticks closer than this overlap; past it the rail samples every nth row. */
const MIN_TICK_PX = 3;

function tickOf(block: Block, turnId: string): Tick | null {
  if (block.role === "user") {
    return { id: block.id, turnId, kind: "user", text: block.text };
  }
  if (isErrorBlock(block)) {
    return { id: block.id, turnId, kind: "alert", text: block.text };
  }
  if (block.role === "tool") {
    return {
      id: block.id,
      turnId,
      kind: isEditBlock(block) ? "edit" : "tool",
      text: toolCallLabel(block),
    };
  }
  if (isProseBlock(block) && block.text) {
    return { id: block.id, turnId, kind: "reply", text: block.text };
  }
  return null;
}

function ticksOf(turns: Block[][]): Tick[] {
  const ticks: Tick[] = [];
  for (const turn of turns) {
    for (const block of turn) {
      const tick = tickOf(block, turn[0].id);
      if (tick) ticks.push(tick);
    }
  }
  return ticks;
}

export const TranscriptMinimap = memo(function TranscriptMinimap({
  scroller,
  turns,
  visible,
  onJump,
}: {
  scroller: HTMLDivElement | null;
  turns: Block[][];
  visible: boolean;
  onJump: (target: HTMLElement) => void;
}) {
  const ticks = useMemo(() => ticksOf(turns), [turns]);
  const railH = Math.min(Math.max(ticks.length * ROW_PX, MIN_RAIL), MAX_RAIL);
  const shown = useMemo(() => {
    const stride = Math.max(1, Math.ceil((ticks.length * MIN_TICK_PX) / railH));
    const out: { tick: Tick; index: number }[] = [];
    for (let index = 0; index < ticks.length; index += stride) {
      out.push({ tick: ticks[index], index });
    }
    return out;
  }, [ticks, railH]);
  const windowRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Tick | null>(null);

  useEffect(() => {
    const el = scroller;
    const win = windowRef.current;
    if (!el || !win || !visible) return;
    const sync = () => {
      const total = el.scrollHeight || 1;
      const top = (el.scrollTop / total) * railH;
      const height = Math.max(MIN_WINDOW, (el.clientHeight / total) * railH);
      win.style.transform = `translateY(${top}px)`;
      win.style.height = `${Math.min(height, railH - top)}px`;
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [scroller, visible, railH, ticks.length]);

  if (turns.length < 2 || ticks.length === 0) return null;

  const jump = (tick: Tick) => {
    const target = scroller?.querySelector<HTMLElement>(
      `[data-turn="${CSS.escape(tick.turnId)}"]`,
    );
    if (target) onJump(target);
  };

  return (
    <div
      className="absolute top-1/2 left-1 z-10 w-5 -translate-y-1/2 opacity-60 transition-opacity hover:opacity-100"
      style={{ height: railH }}
      onMouseLeave={() => setHover(null)}
    >
      <div
        ref={windowRef}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 rounded-md bg-content/8"
      />
      {shown.map(({ tick, index }) => {
        const spec = TICK[tick.kind];
        const hovered = hover?.id === tick.id;
        return (
          <button
            key={tick.id}
            type="button"
            tabIndex={-1}
            aria-label={`${spec.who}: ${tick.text.slice(0, 80)}`}
            className="absolute left-0 flex h-[3px] items-center"
            style={{ top: (index / ticks.length) * railH, width: 20 }}
            onMouseEnter={() => setHover(tick)}
            onClick={() => jump(tick)}
          >
            <span
              className={`block h-0.5 rounded-full transition-[width,opacity] duration-100 ${spec.className}`}
              style={{ width: spec.width + (hovered ? 4 : 0) }}
            />
          </button>
        );
      })}
      {hover ? (
        <div
          className="z-fade-quick pointer-events-none absolute left-7 w-64 rounded-xl border border-content/10 bg-content/10 px-2.5 py-1.5 font-sans text-[12px] shadow-xl glass-surface glass-surface--xl"
          style={{
            top: Math.min(
              railH - 24,
              (ticks.findIndex((t) => t.id === hover.id) / ticks.length) * railH - 8,
            ),
          }}
        >
          <div className="mb-0.5 text-[10px] font-medium tracking-wide text-content/40 uppercase">
            {TICK[hover.kind].who}
          </div>
          <div className="line-clamp-2 text-content/70">{hover.text.trim()}</div>
        </div>
      ) : null}
    </div>
  );
});
