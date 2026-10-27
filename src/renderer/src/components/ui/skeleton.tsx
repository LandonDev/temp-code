import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

/** A loading placeholder shaped like the content it stands in for: a
 *  muted block with one slow shimmer sweep (`.skeleton-shimmer`). */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("skeleton-shimmer rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
