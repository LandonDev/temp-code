import { CircleAlert, CircleCheck, Info } from "@renderer/chrome/icons";
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";

/** An inline callout, tinted by tone. For something the person must read
 *  where they are; a notice row in the transcript is not an Alert. */
const ALERT_MARKS = { error: CircleAlert, warning: CircleAlert, success: CircleCheck, info: Info } as const;

type AlertTone = keyof typeof ALERT_MARKS;

const ALERT_TONES: Record<AlertTone, string> = {
  error: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  success: "bg-success/10 text-success",
  info: "bg-info/10 text-info",
};

const alertVariants = cva("group/alert relative grid w-full grid-cols-[auto_1fr] gap-x-2.5 gap-y-0 rounded-lg px-3 py-2.5 text-start text-[13px] has-data-[slot=alert-action]:pe-16", {
  variants: { variant: ALERT_TONES },
  defaultVariants: { variant: "info" },
});

function Alert({ className, variant = "info", children, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const Mark = ALERT_MARKS[variant ?? "info"];
  return (
    <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
      <Mark data-slot="alert-mark" aria-hidden="true" className="row-span-2 size-4 self-center" />
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("col-start-2 font-medium text-foreground [&_a]:underline [&_a]:underline-offset-3", className)} {...props} />;
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("col-start-2 text-[13px] text-foreground/80 [&_a]:underline [&_a]:underline-offset-3 [&_p:not(:last-child)]:mb-3", className)} {...props} />;
}

function AlertAction({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-action" className={cn("absolute end-2 top-2", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription, AlertAction, ALERT_MARKS, type AlertTone };
