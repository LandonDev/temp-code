import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { toast as Toast, ToasterProps } from "sonner";
import { Info } from "@renderer/chrome/icons";
import { Spinner } from "./spinner";
import { StatusMark, type ThreadState } from "./status";
import { buttonVariants } from "./button";
import { cn } from "@renderer/lib/cn";
import { subscribeToastAnchor, toastAnchor } from "@renderer/lib/toastAnchor";

export type ToastApi = typeof Toast;

/** sonner rides its own chunk, out of the first paint: every toast goes
 *  through `loadToast().then((toast) => toast(…))`, and nothing else in
 *  src/renderer imports "sonner" for its values. */
let loading: Promise<ToastApi> | null = null;
export function loadToast(): Promise<ToastApi> {
  loading ??= import("sonner").then((m) => m.toast);
  return loading;
}

/** What a toast's raised button resets of sonner's own button (its fill, 4px
 *  radius, size and colour, which sonner writes on the element). */
const TOAST_BUTTON = "!h-6 !rounded-md !bg-transparent !px-2 !text-xs !font-medium !transition-[opacity] !duration-(--dur-fast)";

const Sonner = lazy(() => import("sonner").then((m) => ({ default: m.Toaster })));

/** The stack's distance from the window's bottom and right edges, and a toast's width. */
export type ToastInset = { bottom: number; right: number; width: number };

/** Gap between the stack and the strip, and between the stack and the column's edge. */
const ABOVE = 8;
const INSIDE = 16;
/** A toast's width where its column has the room (sonner's `--width`). */
export const TOAST_WIDTH = 340;

/**
 * Where the stack sits so a toast never covers a control: 8px above the
 * anchor's top (the focused thread's strip, above its composer; a master
 * board's foot while its chat is folded) and 16px inside its right edge
 * (clear of the right panel), no wider than the column less 16px a side
 * (a master's chat beside its board is narrower than a toast); 16/16 from
 * the window's corner with no anchor. Never closer than 16px to either edge.
 */
export function toastInset(
  viewport: { width: number; height: number },
  anchor: { top: number; right: number; left?: number } | null,
): ToastInset {
  if (!anchor) return { bottom: INSIDE, right: INSIDE, width: TOAST_WIDTH };
  const room = anchor.left === undefined ? TOAST_WIDTH : Math.round(anchor.right - anchor.left - 2 * INSIDE);
  return {
    bottom: Math.max(INSIDE, Math.round(viewport.height - anchor.top + ABOVE)),
    right: Math.max(INSIDE, Math.round(viewport.width - anchor.right + INSIDE)),
    width: Math.max(0, Math.min(TOAST_WIDTH, room)),
  };
}

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The measured inset for the current anchor, kept as it resizes or moves. */
function useToastInset(): ToastInset {
  const anchor = useSyncExternalStore(subscribeToastAnchor, toastAnchor, () => null);
  const [inset, setInset] = useState<ToastInset>({ bottom: INSIDE, right: INSIDE, width: TOAST_WIDTH });
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = toastInset(viewport(), anchor?.getBoundingClientRect() ?? null);
        setInset((prev) => (prev.bottom === next.bottom && prev.right === next.right && prev.width === next.width ? prev : next));
      });
    };
    measure();
    // The footer grows with the composer; its column narrows when a panel opens.
    const observer = anchor && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (anchor) {
      observer?.observe(anchor);
      if (anchor.parentElement) observer?.observe(anchor.parentElement);
    }
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);
  return inset;
}

/** A toast's glyph in the status vocabulary (docs/DESIGN.md): a toast that
 *  needs the person is waiting's amber ring-dot, a failure failed's red
 *  ring with a bang, a success done's muted check. The title says the words,
 *  so the glyph is hidden from assistive tech. */
function ToastGlyph({ state }: { state: ThreadState }) {
  return (
    <span aria-hidden data-toast-glyph={state} className="contents">
      <StatusMark state={state} word={false} />
    </span>
  );
}

/** The one toast stack (sonner), mounted once in main.tsx. A toast is one
 *  line, an optional second line, at most one action, and leaves on its own.
 *  It sits above the focused thread's strip, never over a control. */
export function Toaster(props: ToasterProps) {
  const { width, ...offset } = useToastInset();
  return (
    <Suspense fallback={null}>
      <Sonner
        position="bottom-right"
        gap={8}
        offset={offset}
        mobileOffset={offset}
        visibleToasts={4}
        icons={{
          success: <ToastGlyph state="done" />,
          info: <Info className="size-4" />,
          warning: <ToastGlyph state="waiting" />,
          error: <ToastGlyph state="failed" />,
          loading: <Spinner />,
        }}
        toastOptions={{
          unstyled: false,
          classNames: {
            // The glyph sits on the title's first line, not the middle of two.
            toast: "!items-start !gap-2 !rounded-xl !border-0 !bg-popover !text-popover-foreground !shadow-overlay !ring-1 !ring-border !text-[13px]",
            title: "!font-medium !leading-5",
            description: "!text-xs !leading-4 !text-muted-foreground",
            icon: "!h-5",
            // Our raised buttons: sonner's own button paints a background, a 4px radius
            // and its own sizes, so those are reset for the raise's fill layer to show.
            actionButton: cn(buttonVariants({ variant: "default", size: "xs" }), TOAST_BUTTON, "!text-primary-foreground"),
            cancelButton: cn(buttonVariants({ variant: "secondary", size: "xs" }), TOAST_BUTTON, "!text-secondary-foreground"),
          },
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius-xl)",
            "--width": `${width}px`,
          } as CSSProperties
        }
        {...props}
      />
    </Suspense>
  );
}
