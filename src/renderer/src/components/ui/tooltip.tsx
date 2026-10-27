import type { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cloneElement, isValidElement, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { defineChunk } from "@renderer/lib/lazyChunk";
import type * as Primitive from "./tooltip-primitive";

/** The hover delay before a label opens, and the grace after the pointer
 *  leaves during which a neighbour's label moves instead of reopening. A
 *  Popover opened on hover reads these rather than writing a number. */
export const TOOLTIP_DELAY = 400;
export const TOOLTIP_CLOSE_DELAY = 120;

/**
 * Tooltips open after a short delay, from the trigger, as one dark label.
 * Each Tooltip carries its own delay; a TooltipProvider around a toolbar
 * makes neighbours share one so the label moves instead of reopening.
 * Never a Tooltip beside a title=.
 *
 * The Base UI primitive and its floating stack (about 150 kB) stay out of
 * the first paint: until `tooltipChunk` loads, a Tooltip is its trigger
 * alone, rendered as the same element, and the pointer entering any trigger
 * (or the idle slot after the first thread opens) loads the primitive, after
 * which every tooltip is the real one. Focus never loads it, so a focused
 * trigger is not remounted under the keyboard.
 */
export const tooltipChunk = defineChunk("tooltip", () => import("./tooltip-primitive"));

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Whether a swap now would pull the rug from under the keyboard: a field
 *  being typed in, or any focused control. */
function focusHeld(): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return !!active && active !== document.body;
}

/** Wakes every cold tooltip on screen; while a control has focus the swap
 *  waits for the focus to leave, so a rename in progress keeps its text. */
function wake(): void {
  if (published) return;
  if (focusHeld()) {
    document.addEventListener("focusout", () => queueMicrotask(wake), { once: true });
    return;
  }
  published = tooltipChunk.loaded();
  for (const listener of listeners) listener();
}

/** Test seam: forget the published primitive. */
export function resetTooltips(): void {
  published = null;
}

/** Loads the primitive and wakes every cold tooltip on screen. */
export function warmTooltips(): void {
  if (published) return;
  if (tooltipChunk.loaded()) wake();
  else tooltipChunk.load().then(wake, () => {});
}
/** The primitive the tooltips render with: set by `wake` alone, so a cold
 *  tooltip re-rendering after the chunk loaded does not swap on its own. */
let published: typeof Primitive | null = null;
const read = (): typeof Primitive | null => published;
function usePrimitive(): typeof Primitive | null {
  return useSyncExternalStore(subscribe, read, read);
}

function TooltipProvider(props: TooltipPrimitive.Provider.Props) {
  const P = usePrimitive();
  return P ? <P.TooltipProvider {...props} /> : <>{props.children}</>;
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const P = usePrimitive();
  return P ? <P.Tooltip {...props} /> : <>{props.children}</>;
}

type ColdTrigger = { render?: unknown; children?: ReactNode; className?: string };

function TooltipTrigger<Payload>(props: TooltipPrimitive.Trigger.Props<Payload>) {
  const P = usePrimitive();
  if (P) return <P.TooltipTrigger {...props} />;
  const { render, children, className } = props as ColdTrigger;
  const warm = { onPointerEnter: warmTooltips };
  if (isValidElement(render)) {
    const element = render as ReactElement<{ onPointerEnter?: (event: unknown) => void; children?: ReactNode }>;
    const given = element.props.onPointerEnter;
    return cloneElement(
      element,
      {
        onPointerEnter: (event: unknown) => {
          given?.(event);
          warmTooltips();
        },
      },
      children ?? element.props.children,
    );
  }
  if (typeof render === "function") {
    return (render as (props: Record<string, unknown>, state: { open: boolean }) => ReactElement)({ ...warm, children, className }, { open: false });
  }
  return (
    <button type="button" data-slot="tooltip-trigger" className={className} {...warm}>
      {children}
    </button>
  );
}

function TooltipContent(props: Parameters<typeof Primitive.TooltipContent>[0]) {
  const P = usePrimitive();
  return P ? <P.TooltipContent {...props} /> : null;
}

function TooltipArrow(props: TooltipPrimitive.Arrow.Props) {
  const P = usePrimitive();
  return P ? <P.TooltipArrow {...props} /> : null;
}

export { Tooltip, TooltipArrow, TooltipTrigger, TooltipContent, TooltipProvider };
