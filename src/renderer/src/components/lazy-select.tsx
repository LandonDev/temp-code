import { useState, useSyncExternalStore, type ComponentProps, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import { ChevronDown } from "@renderer/chrome/icons";
import { cn } from "@renderer/lib/cn";
import { selectChunk } from "../surfaces/chunks";
import { SELECT_CHEVRON, SELECT_TRIGGER, SELECT_VALUE } from "./ui/select-trigger";
import type * as Body from "./select-body";

/**
 * Base UI's select stays out of the first paint: the composer's pickers
 * (permission mode, thread type, the model menu's setting rows) render
 * their real select from `selectChunk` (components/select-body.ts), and
 * until it has landed each is a still trigger drawn with the same classes
 * and attributes (`ColdSelectTrigger`), so the swap moves nothing. The
 * pointer entering a cold trigger loads the chunk and swaps every picker
 * on screen at once; a focus only loads it (a swap would take the focus
 * from under the keyboard); a click loads it and opens the select as soon
 * as it has landed. A picker that mounts after the chunk is loaded (the
 * idle slot after the first thread opens loads it) is the real one at once.
 */

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** The bodies the pickers render with: set by `wake` alone, so a cold picker
 *  re-rendering after the chunk loaded does not swap under its focus. */
let published: typeof Body | null = null;
const read = (): typeof Body | null => published;

function wake(): void {
  if (published) return;
  published = selectChunk.loaded();
  for (const listener of listeners) listener();
}

/** Loads the select bodies and swaps every cold picker on screen to them. */
export function warmSelects(): void {
  if (published) return;
  if (selectChunk.loaded()) wake();
  else selectChunk.load().then(wake, () => {});
}

/** Test seam: forget the published bodies. */
export function resetSelects(): void {
  published = null;
}

/** The select bodies once published, or once loaded when this picker mounted; null while cold. */
export function useSelectBody(): typeof Body | null {
  const [atMount] = useState(() => selectChunk.loaded());
  return useSyncExternalStore(subscribe, read, read) ?? atMount;
}

/** A cold picker's open request: true from its click until it swaps, so the
 *  real select mounts open (`defaultOpen`). */
export function usePendingOpen(): [boolean, () => void] {
  const [pending, setPending] = useState(false);
  return [
    pending,
    () => {
      setPending(true);
      warmSelects();
    },
  ];
}

type ColdProps = ComponentProps<"button"> & { size?: "sm" | "default"; onOpen: () => void };

/** `SelectTrigger` before the select chunk lands: the same box, value slot
 *  and chevron, with the combobox's closed state. */
export function ColdSelectTrigger({ size = "default", className, children, onOpen, onPointerEnter, onFocus, onClick, ...props }: ColdProps) {
  return (
    <button
      type="button"
      role="combobox"
      aria-expanded={false}
      aria-haspopup="listbox"
      data-slot="select-trigger"
      data-size={size}
      className={cn(SELECT_TRIGGER, className)}
      onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerEnter?.(event);
        warmSelects();
      }}
      onFocus={(event: FocusEvent<HTMLButtonElement>) => {
        onFocus?.(event);
        selectChunk.preload();
      }}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        onOpen();
      }}
      {...props}
    >
      <span data-slot="select-value" className={SELECT_VALUE}>
        {children}
      </span>
      <ChevronDown aria-hidden className={SELECT_CHEVRON} />
    </button>
  );
}
