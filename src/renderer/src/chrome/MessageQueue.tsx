import { useState } from "react";
import { AnimatePresence, Reorder, useReducedMotion } from "motion/react";
import type { QueuedMessage } from "../lib/tcserver/types";
import { ArrowUp, GripVertical, X } from "./icons";

type Props = {
  items: QueuedMessage[];
  /** The turn is paused: rows wait for Continue, so ↑ is hidden. */
  paused?: boolean;
  onSteer: (messageId: string) => void;
  onRemove: (messageId: string) => void;
  onUpdate: (messageId: string, text: string) => void;
  onReorder: (order: string[]) => void;
};

/**
 * Messages waiting their turn, stacked above the composer. Each sends as
 * turns settle, in order. Drag to reorder, click the text to edit in
 * place, ✕ removes, ↑ steers it into the running turn now (providers that
 * cannot steer send it next instead).
 */
export function MessageQueue({ items, paused, onSteer, onRemove, onUpdate, onReorder }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const reduce = useReducedMotion();

  if (items.length === 0) return null;

  return (
    <div className="mb-2">
      <p className="mb-1 px-1 text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">
        Queued · {items.length}
      </p>
      <Reorder.Group
        axis="y"
        values={items.map((m) => m.id)}
        onReorder={(order) => onReorder(order as string[])}
        className="flex flex-col gap-1"
      >
        <AnimatePresence initial={false}>
          {items.map((m, ix) => (
            <Reorder.Item
              key={m.id}
              value={m.id}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              className="group/q relative"
            >
              <div className="flex items-start gap-1.5 rounded-lg border border-content/10 bg-content/3 py-1.5 pr-1.5 pl-1">
                <span className="mt-[3px] cursor-grab text-content/30 active:cursor-grabbing">
                  <GripVertical className="size-3.5" />
                </span>
                {editing === m.id ? (
                  <textarea
                    autoFocus
                    defaultValue={m.text}
                    rows={Math.min(4, m.text.split("\n").length)}
                    onFocus={(e) =>
                      e.currentTarget.setSelectionRange(
                        e.currentTarget.value.length,
                        e.currentTarget.value.length,
                      )
                    }
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                      if (e.key === "Escape") {
                        e.currentTarget.value = m.text;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      setEditing(null);
                      const v = e.target.value.trim();
                      if (v && v !== m.text) onUpdate(m.id, v);
                    }}
                    className="min-w-0 flex-1 resize-none bg-transparent text-[12.5px] leading-5 text-content outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(m.id)}
                    title="Edit"
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="line-clamp-2 text-[12.5px] leading-5 text-content/60">
                      <span className="mr-1.5 text-[10.5px] text-content/35 tabular-nums">{ix + 1}</span>
                      {m.text}
                    </span>
                  </button>
                )}
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/q:opacity-100 focus-within:opacity-100">
                  {paused ? null : (
                    <button
                      type="button"
                      onClick={() => onSteer(m.id)}
                      aria-label="Send now"
                      title="Send now, into the running turn"
                      className="flex size-5 items-center justify-center rounded text-content/60 transition hover:bg-content/10 hover:text-content active:scale-[0.96]"
                    >
                      <ArrowUp className="size-3" strokeWidth={2.25} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(m.id)}
                    aria-label="Remove from queue"
                    className="flex size-5 items-center justify-center rounded text-content/60 transition hover:bg-content/10 hover:text-content active:scale-[0.96]"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              </div>
            </Reorder.Item>
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </div>
  );
}
