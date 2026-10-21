import { useState, type MouseEvent } from "react";
import { ChevronRight } from "../chrome/icons";

/**
 * The project rules a thread's first message opened with, folded to one
 * line above the brief the person wrote: "Project rules · 212 words".
 * Click opens the text in place; the bubble's own clamp toggle never sees
 * the click. The thread keeps the text it started with, so this is a
 * record, not an editor.
 */
export function PreambleRow({ text, words }: { text: string; words: number }) {
  const [open, setOpen] = useState(false);
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };
  return (
    <div className="mb-1.5 flex flex-col gap-1" data-preamble-row>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="-ml-1 flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-content/50 hover:text-content/70"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
        />
        <span>
          Project rules<span className="text-content/35"> · {words} word{words === 1 ? "" : "s"}</span>
        </span>
      </button>
      {open ? (
        <pre
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 whitespace-pre-wrap break-words border-l border-content/15 pl-2.5 font-sans text-[12px] leading-5 text-content/60"
        >
          {text}
        </pre>
      ) : null}
    </div>
  );
}
