import { useRef, useState } from "react";
import { ChevronDown } from "../icons";
import { Popover } from "../Popover";
import { cn } from "../../motion/cn";

/**
 * The rail panels' branch pickers: a flat, mono trigger that reads as a
 * label until hovered, opening a grouped menu on the donor's Popover.
 */

export interface RailSelectGroup {
  label?: string;
  items: { value: string; label: string; title?: string }[];
}

export function RailSelect({
  value,
  placeholder = "…",
  groups,
  disabled = false,
  title,
  ariaLabel,
  onChange,
}: {
  value: string | null;
  placeholder?: string;
  groups: RailSelectGroup[];
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const inert = disabled || count === 0;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={inert}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md px-1 font-mono text-[11px] text-content transition-colors",
          !inert && "hover:bg-content/8",
          inert && "cursor-default",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate text-left", !value && "text-content/40")}>
          {value ?? placeholder}
        </span>
        {!inert ? (
          <ChevronDown className="size-3 shrink-0 text-content/40" strokeWidth={1.75} />
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="bottom"
          align="start"
          gap={4}
          width={232}
          maxHeight={320}
          autoFocus
          onDismiss={() => setOpen(false)}
          role="menu"
          tabIndex={-1}
          aria-label={ariaLabel}
          className="overflow-y-auto overscroll-none p-1"
        >
          {groups.map((group, gi) =>
            group.items.length === 0 ? null : (
              <div key={gi}>
                {gi > 0 ? <div role="separator" className="my-1 h-px bg-content/10" /> : null}
                {group.label ? (
                  <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-content/40">
                    {group.label}
                  </div>
                ) : null}
                {group.items.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={item.value === value}
                    title={item.title}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setOpen(false);
                      if (item.value !== value) onChange(item.value);
                    }}
                    className={cn(
                      "flex h-7 w-full items-center rounded-lg px-2 text-left font-mono text-[12px] leading-none",
                      item.value === value ? "bg-content/10 text-content" : "text-content hover:bg-content/5",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            ),
          )}
        </Popover>
      ) : null}
    </>
  );
}
