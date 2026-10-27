import { lazy, Suspense, type CSSProperties } from "react";
import type { toast as Toast, ToasterProps } from "sonner";
import { CircleAlert, CircleCheck, Info } from "@renderer/chrome/icons";
import { Spinner } from "./spinner";

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

/** The one toast stack (sonner), mounted once in main.tsx. A toast is one
 *  line, an optional second line, at most one action, and leaves on its own. */
export function Toaster(props: ToasterProps) {
  return (
    <Suspense fallback={null}>
      <Sonner
        position="bottom-right"
        gap={8}
        offset={16}
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
