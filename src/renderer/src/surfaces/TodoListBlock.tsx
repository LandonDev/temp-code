import { memo } from "react";
import type { TodoItem } from "../lib/toolDetails";
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
  return (
    <div className="py-1">
      <TodoList items={items} />
    </div>
  );
});

/** The list itself, the same card whether it stands as a row or opens under a tool. */
export function TodoList({ items }: { items: TodoItem[] }) {
  const done = items.filter((t) => t.status === "completed").length;
  return (
      <div className="rounded-[10px] border border-content/10 bg-content/6 px-3 py-2 font-sans text-[13px]">
        <div className="mb-1 flex items-center justify-between text-[11px] text-content/40">
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
                t.status === "completed" ? "text-content/40 line-through" : "text-content"
              }`}
            >
              <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-content/40">
                {t.status === "completed" ? (
                  <Check className="size-3.5" strokeWidth={1.75} />
                ) : t.status === "in_progress" ? (
                  <Minus className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <Circle className="size-3.5" strokeWidth={1.75} />
                )}
              </span>
              <span className="min-w-0">{t.text}</span>
            </li>
          ))}
        </ul>
      </div>
  );
}
