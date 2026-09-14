import { memo, useMemo, type CSSProperties, type ElementType } from "react";
import { usePaneVisible } from "../hooks/paneVisibility";

export interface ShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

function ShimmerComponent({
  children,
  as: Component = "span",
  className = "",
  duration = 1.4,
  spread = 2,
}: ShimmerProps) {
  const shown = usePaneVisible();
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  return (
    <Component
      className={`${shown ? "shimmer-text " : ""}relative inline-block ${className}`.trim()}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--shimmer-duration": `${duration}s`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
}

export const Shimmer = memo(ShimmerComponent);
