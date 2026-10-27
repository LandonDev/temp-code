import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

/** A loading placeholder shaped like the content it stands in for: a
 *  still muted block. Only text being produced shimmers (docs/DESIGN.md). */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
