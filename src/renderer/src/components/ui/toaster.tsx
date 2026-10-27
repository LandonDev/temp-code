import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { toast as Toast, ToasterProps } from "sonner";
import { CircleAlert, CircleCheck, Info } from "@renderer/chrome/icons";
import { Spinner } from "./spinner";
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

const Sonner = lazy(() => import("sonner").then((m) => ({ default: m.Toaster })));

/** The stack's distance from the window's bottom and right edges. */
export type ToastInset = { bottom: number; right: number };

/** Gap between the stack and the strip, and between the stack and the column's edge. */
const ABOVE = 8;
const INSIDE = 16;

/**
 * Where the stack sits so a toast never covers a control: 8px above the
 * anchor's top (the focused thread's strip, above its composer) and 16px
 * inside its right edge (clear of the right panel); 16/16 from the window's
 * corner with no anchor. Never closer than 16px to either edge.
 */
export function toastInset(
  viewport: { width: number; height: number },
  anchor: { top: number; right: number } | null,
): ToastInset {
  if (!anchor) return { bottom: INSIDE, right: INSIDE };
  return {
    bottom: Math.max(INSIDE, Math.round(viewport.height - anchor.top + ABOVE)),
    right: Math.max(INSIDE, Math.round(viewport.width - anchor.right + INSIDE)),
  };
}

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The measured inset for the current anchor, kept as it resizes or moves. */
function useToastInset(): ToastInset {
  const anchor = useSyncExternalStore(subscribeToastAnchor, toastAnchor, () => null);
  const [inset, setInset] = useState<ToastInset>({ bottom: INSIDE, right: INSIDE });
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = toastInset(viewport(), anchor?.getBoundingClientRect() ?? null);
        setInset((prev) => (prev.bottom === next.bottom && prev.right === next.right ? prev : next));
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

/** The one toast stack (sonner), mounted once in main.tsx. A toast is one
 *  line, an optional second line, at most one action, and leaves on its own.
 *  It sits above the focused thread's strip, never over a control. */
export function Toaster(props: ToasterProps) {
  const offset = useToastInset();
  return (
    <Suspense fallback={null}>
      <Sonner
        position="bottom-right"
        gap={8}
        offset={offset}
        mobileOffset={offset}
        visibleToasts={4}
        icons={{
          success: <CircleCheck className="size-4" />,
          info: <Info className="size-4" />,
          warning: <CircleAlert className="size-4" />,
          error: <CircleAlert className="size-4" />,
          loading: <Spinner />,
        }}
        toastOptions={{
          unstyled: false,
          classNames: {
            toast: "!rounded-xl !border-0 !bg-popover !text-popover-foreground !shadow-overlay !ring-1 !ring-border !text-[13px]",
            title: "!font-medium",
            description: "!text-muted-foreground",
            actionButton: "!h-7 !rounded-md !bg-primary !text-primary-foreground !text-xs",
            cancelButton: "!h-7 !rounded-md !bg-muted !text-foreground !text-xs",
          },
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "12px",
            "--width": "340px",
          } as CSSProperties
        }
        {...props}
      />
    </Suspense>
  );
}
