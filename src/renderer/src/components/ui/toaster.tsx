import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CircleAlert, CircleCheck, Info } from "@renderer/chrome/icons";
import { Spinner } from "./spinner";

/** The one toast stack (sonner), mounted once in main.tsx. Call `toast()`
 *  from "sonner" anywhere; a toast is one line, an optional second line,
 *  at most one action, and leaves on its own. */
export function Toaster(props: ToasterProps) {
  return (
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
  );
}
