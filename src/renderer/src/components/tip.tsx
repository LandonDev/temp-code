import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type Ref } from "react";
import { Kbd } from "./ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Side = "top" | "bottom" | "left" | "right";

/**
 * A label on hover. `Tip` names an icon-only control (its `aria-label`
 * stays the accessible name; the tip is the pointer's help) with the key
 * cap of its binding when it has one (lib/settings.ts `shortcutFor`).
 * Neighbours in a toolbar share one `TooltipProvider`, so the label moves
 * between them instead of reopening.
 */
export function Tip({
  label,
  shortcut,
  side = "bottom",
  disabled,
  children,
}: {
  label: string;
  shortcut?: string;
  side?: Side;
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {shortcut ? <Kbd size="sm">{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Text that may be cut off, with the whole of it on hover only while it is
 * cut. `children` is the truncating element (a DOM element, or a component
 * that puts its ref on one).
 */
export function TruncateTip({
  text,
  side = "bottom",
  children,
}: {
  text: string;
  side?: Side;
  children: ReactElement<{ ref?: Ref<HTMLElement> }>;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return (
    <Tooltip disabled={!cut}>
      <TooltipTrigger render={cloneElement(children, { ref })} />
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  );
}
