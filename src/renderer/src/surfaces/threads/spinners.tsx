import { useReducedMotion } from "motion/react";
import type { ActivityKind } from "../../lib/session";

/**
 * The two spinners the app had before components/ui/spinner, kept here only
 * until A21 swaps their last users onto `Spinner` from the component library.
 */

/** 750ms diagonal wave over a 3×3 matrix of cells. `tint` recolours the
 *  cells by what the thread is doing: pink while investigating, green
 *  while editing, the busy pink-gray while thinking. */
export function MatrixSpinner({
  cell = 2.5,
  tint,
}: {
  cell?: number;
  tint?: ActivityKind | null;
}) {
  const tintClass =
    tint === "investigate" ? "bg-busy" : tint === "edit" ? "bg-success" : "bg-busy";
  const reduce = useReducedMotion();
  return (
    <span className="grid shrink-0 grid-cols-3" style={{ gap: cell * 0.6 }}>
      {Array.from({ length: 9 }, (_, n) => {
        const diag = (n % 3) + Math.floor(n / 3);
        return (
          <span
            key={n}
            className={`z-matrix-cell rounded-[0.5px] transition-colors ${tintClass}`}
            style={{
              width: cell,
              height: cell,
              animation: reduce ? "none" : "z-matrix 750ms linear infinite",
              animationDelay: `${diag * -150}ms`,
            }}
          />
        );
      })}
    </span>
  );
}

export function Spinner({ className = "size-3" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 motion-safe:animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`}
    />
  );
}
