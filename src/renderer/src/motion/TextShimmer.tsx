import { useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * A soft highlight sweeps through the text while a background process
 * runs. Reduced motion falls back to static muted text.
 */
export function TextShimmer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={cn("text-content/55", className)}>{children}</span>;
  return (
    <span
      className={cn(
        "animate-[text-shimmer_1.4s_linear_infinite] bg-[linear-gradient(90deg,var(--shimmer-dim)_35%,var(--color-content)_50%,var(--shimmer-dim)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent [--shimmer-dim:color-mix(in_srgb,var(--color-content)_55%,transparent)]",
        className,
      )}
    >
      {children}
    </span>
  );
}
