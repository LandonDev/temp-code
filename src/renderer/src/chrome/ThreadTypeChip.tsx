import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "./icons";
import { Popover } from "./Popover";
import type { ThreadType } from "../lib/tcserver/types";
import {
  THREAD_GLYPHS,
  THREAD_HINTS,
  THREAD_LABELS,
  THREAD_TINTS,
  THREAD_TYPES,
} from "../surfaces/threads/bits";

type Props = {
  value: ThreadType;
  onChange: (type: ThreadType) => void;
  onClose?: () => void;
};

const MENU_WIDTH = 272;

/** What kind of thread this is, in the composer's top row. Same shape as
 *  the access picker: a chip that opens a listbox of the five types. */
export function ThreadTypeChip({ value, onChange, onClose }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, THREAD_TYPES.indexOf(value)));
  const root = useRef<HTMLDivElement>(null);
  const Glyph = THREAD_GLYPHS[value];

  const dismiss = (restore: boolean) => {
    setOpen(false);
    if (restore) onClose?.();
  };
  const pick = (type: ThreadType) => {
    if (type !== value) onChange(type);
    dismiss(true);
  };
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(THREAD_TYPES.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(THREAD_TYPES[active]);
    }
  };

  return (
    <div ref={root} className="relative shrink-0" data-thread-type-picker>
      <button
        type="button"
        title={THREAD_HINTS[value]}
        aria-label={`Thread type: ${THREAD_LABELS[value]}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) {
            dismiss(true);
            return;
          }
          setActive(Math.max(0, THREAD_TYPES.indexOf(value)));
          setOpen(true);
        }}
        className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] ${
          open ? "bg-content/10 text-content" : "text-content/70 hover:bg-content/8 hover:text-content"
        }`}
      >
        <Glyph className={`size-3.5 shrink-0 ${THREAD_TINTS[value]}`} strokeWidth={1.75} />
        <span className="min-w-0 truncate">{THREAD_LABELS[value]}</span>
        <ChevronDown
          className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="start"
          width={MENU_WIDTH}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="listbox"
          aria-label="Thread type"
          data-thread-type-picker
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="p-1"
        >
          {THREAD_TYPES.map((type, index) => {
            const Icon = THREAD_GLYPHS[type];
            const selected = type === value;
            const highlighted = index === active;
            return (
              <button
                key={type}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(type)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${
                  highlighted ? "bg-content/10" : ""
                }`}
              >
                <Icon className={`size-4 shrink-0 ${THREAD_TINTS[type]}`} strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[12px] leading-tight ${selected ? "text-content" : "text-content"}`}>
                    {THREAD_LABELS[type]}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-content/40">
                    {THREAD_HINTS[type]}
                  </span>
                </span>
              </button>
            );
          })}
        </Popover>
      ) : null}
    </div>
  );
}
