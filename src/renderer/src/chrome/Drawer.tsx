import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EASE_DRAWER_CSS, EASE_OUT_CSS } from "../lib/ease";

export const DRAWER_OPEN_MS = 280;
export const DRAWER_CLOSE_MS = 200;
export const DRAWER_FADE_MS = 120;

/**
 * A push panel docked at a column's right edge. The shell's width tweens
 * (280ms open, 200ms close, the drawer curve, no bounce; a toggle mid-flight
 * turns around from wherever it is) while the content sits inside at its
 * final width, anchored to the shell's left edge, so it slides in from the
 * right and never re-lays out. The shell clips and is `contain: strict`, so
 * the tween costs the neighbour a width change and nothing more. Content
 * fades in over 120ms as the slide starts and fades out with the close.
 * Under reduced motion only the fade plays.
 *
 * `closed` is what the folded shell shows (an edge tab). With `keepMounted`
 * the content stays in the DOM while folded, invisible and inert, so a
 * streaming transcript keeps its scroll; without it the content unmounts
 * once the close has played, and a shell with nothing to show renders
 * nothing at all.
 */
export function Drawer({
  open,
  width,
  closedWidth = 0,
  keepMounted = false,
  as: Tag = "div",
  className = "",
  closed,
  children,
  ...rest
}: {
  open: boolean;
  width: number;
  closedWidth?: number;
  keepMounted?: boolean;
  as?: "div" | "aside";
  className?: string;
  closed?: ReactNode;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  // "open" once the shell is at full width; "closing" while the close tween
  // plays; "closed" after. Derived at render, so the first render after
  // `open` flips false still keeps the shell (and its node) in the tree.
  const [phase, setPhase] = useState<"open" | "closing" | "closed">(open ? "open" : "closed");
  const prev = useRef(open);

  useLayoutEffect(() => {
    if (prev.current === open) return;
    prev.current = open;
    if (open) {
      // Lay the shell out at its closed width first, so the change to
      // `width` below is a transition and not a jump.
      ref.current?.getBoundingClientRect();
      setPhase("open");
      return;
    }
    setPhase("closing");
    const t = setTimeout(() => setPhase("closed"), reduce ? DRAWER_FADE_MS : DRAWER_CLOSE_MS);
    return () => clearTimeout(t);
  }, [open, reduce]);

  const shown = phase === "open";
  const mounted = open || phase !== "closed";
  if (!mounted && !keepMounted && !closed && closedWidth === 0) return null;
  return (
    <Tag
      ref={ref}
      {...rest}
      className={`relative shrink-0 overflow-hidden ${className}`}
      style={{
        width: shown ? width : closedWidth,
        contain: "strict",
        transition: reduce
          ? "none"
          : `width ${shown ? DRAWER_OPEN_MS : DRAWER_CLOSE_MS}ms ${EASE_DRAWER_CSS}`,
      }}
    >
      {!shown ? closed : null}
      {mounted || keepMounted ? (
        <div
          inert={!open}
          className={`absolute inset-y-0 left-0 flex flex-col${mounted ? "" : " invisible"}`}
          style={{ width, opacity: shown ? 1 : 0, transition: `opacity ${DRAWER_FADE_MS}ms ${EASE_OUT_CSS}` }}
        >
          {children}
        </div>
      ) : null}
    </Tag>
  );
}
