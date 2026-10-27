import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

/** The one indeterminate spinner: a 16px arc on a 900ms turn, in the
 *  current colour. Pair it with a word; never spin alone in empty space. */
function Spinner({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 shrink-0 animate-[spin_900ms_linear_infinite] motion-reduce:animate-none", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" pathLength={100} strokeDasharray="72 100" className="origin-center -rotate-[135deg]" />
    </svg>
  );
}

export { Spinner };
