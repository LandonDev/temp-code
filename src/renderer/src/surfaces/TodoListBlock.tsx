import { memo } from "react";
import { Check, Circle, Minus } from "../chrome/icons";
import type { Block } from "../lib/session";
import { todoItems } from "../lib/toolDetails";

/**
 * The agent's todo list as a row of the transcript (ported from temp-code):
 * the list stands where the agent wrote it, so the plan reads in order with
 * the work, instead of hiding behind a folded tool row.
 */
export const TodoListBlock = memo(function TodoListBlock({ block }: { block: Block }) {
  const items = todoItems(block);
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === "completed").length;
  return (
    <div className="px-4 py-1">
      <div className="rounded-lg bg-content/[0.04] px-3 py-2 font-sans text-[13px]">
        <div className="mb-1 flex items-center justify-between text-[11px] text-content/45">
          <span>Todo</span>
          <span className="tabular-nums">
            {done}/{items.length}
          </span>
        </div>
        <ul className="space-y-0.5">
          {items.map((t, n) => (
            <li
              key={n}
              className={`flex items-start gap-2 leading-[18px] ${
                t.status === "completed" ? "text-content/45 line-through" : "text-content/85"
              }`}
            >
              <span className="mt-[3px] flex size-3 shrink-0 items-center justify-center text-content/45">
                {t.status === "completed" ? (
                  <Check className="size-3" strokeWidth={2} />
                ) : t.status === "in_progress" ? (
                  <Minus className="size-3" strokeWidth={2} />
                ) : (
                  <Circle className="size-2.5" strokeWidth={1.75} />
                )}
              </span>
              <span className="min-w-0">{t.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
});
