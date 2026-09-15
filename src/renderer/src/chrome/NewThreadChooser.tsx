import { useRef, useState } from "react";
import type { ThreadRules } from "@server/shared/rules";
import type { ThreadType } from "../lib/tcserver/types";
import { ChevronLeft, Plus, SlidersHorizontal } from "./icons";
import { Popover } from "./Popover";
import { ThreadTune, normalizeTune } from "./ThreadTune";
import { THREAD_GLYPHS, THREAD_HINTS, THREAD_LABELS, THREAD_TINTS, THREAD_TYPES } from "../surfaces/threads/bits";

const TUNABLE: ReadonlySet<ThreadType> = new Set(["orchestration", "research"]);

/**
 * The strip's Plus: a popover naming every thread type, and for the two
 * types that take per-run rules a tune view that swaps in with Back.
 */
export function NewThreadChooser({
  workspaceId,
  empty,
  onStart,
}: {
  workspaceId: string | null;
  /** No chips yet: the button says so in words. */
  empty: boolean;
  onStart: (threadType: ThreadType, tune: ThreadRules | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tuning, setTuning] = useState<ThreadType | null>(null);
  const [tune, setTune] = useState<ThreadRules>({});
  const button = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setOpen(false);
    setTuning(null);
    setTune({});
  };
  const start = (type: ThreadType, rules: ThreadRules | null = null) => {
    close();
    onStart(type, rules);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        title="New thread"
        aria-label="New thread"
        aria-expanded={open}
        data-tauri-drag-region="false"
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md text-content/40 hover:bg-content/5 hover:text-content ${
          empty ? "px-2 text-[13px]" : "w-6 justify-center"
        } ${open ? "bg-content/10 text-content" : ""}`}
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
        {empty ? <span>New thread</span> : null}
      </button>
      {open ? (
        <Popover
          anchor={button}
          side="bottom"
          align="start"
          width={tuning ? 360 : 272}
          className="flex flex-col p-1"
          onDismiss={close}
          ignore="[aria-label='New thread']"
        >
          {tuning ? (
            <>
              <div className="flex items-center gap-1 px-1 pt-0.5">
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() => setTuning(null)}
                  className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
                >
                  <ChevronLeft className="size-3.5" strokeWidth={1.75} />
                </button>
                <span className="text-[13px] font-medium text-content">
                  {THREAD_LABELS[tuning]} options
                </span>
              </div>
              <ThreadTune tune={tune} onChange={setTune} workspaceId={workspaceId} />
              <div className="flex justify-end px-1 pb-1 pt-2">
                <button
                  type="button"
                  onClick={() => start(tuning, normalizeTune(tune))}
                  className="rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/70"
                >
                  Start {THREAD_LABELS[tuning].toLowerCase()}
                </button>
              </div>
            </>
          ) : (
            THREAD_TYPES.map((type) => {
              const Glyph = THREAD_GLYPHS[type];
              return (
                <div key={type} className="group flex items-center rounded-lg hover:bg-content/5">
                  <button
                    type="button"
                    onClick={() => start(type)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
                  >
                    <span className={`grid size-6 shrink-0 place-items-center rounded-md bg-content/6 ${THREAD_TINTS[type]}`}>
                      <Glyph className="size-3.5" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] text-content">{THREAD_LABELS[type]}</span>
                      <span className="block truncate text-[11px] text-content/40">{THREAD_HINTS[type]}</span>
                    </span>
                  </button>
                  {TUNABLE.has(type) ? (
                    <button
                      type="button"
                      title={`${THREAD_LABELS[type]} options`}
                      aria-label={`${THREAD_LABELS[type]} options`}
                      onClick={() => setTuning(type)}
                      className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-content/40 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </Popover>
      ) : null}
    </>
  );
}
