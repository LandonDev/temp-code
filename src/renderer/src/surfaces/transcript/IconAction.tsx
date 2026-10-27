/* A9 (closing lines and code blocks): the transcript's icon buttons. */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { SPRING_LAYOUT } from "@renderer/lib/ease";
import { cn } from "@renderer/lib/cn";

/**
 * Swaps one icon for another (Copy → Check): the new one grows from a
 * quarter size out of a 4px blur, the old one leaves the same way.
 * Reduced motion swaps in place.
 */
export function SwapIcon({ swapped, from, to }: { swapped: boolean; from: ReactNode; to: ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <span className="grid place-items-center">{swapped ? to : from}</span>;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={swapped ? "to" : "from"}
        className="grid place-items-center"
        initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
        transition={SPRING_LAYOUT}
      >
        {swapped ? to : from}
      </motion.span>
    </AnimatePresence>
  );
}

/**
 * A ghost icon button with its name in a tooltip, for row and header
 * actions. `armed={false}` renders the bare button: a row whose actions
 * stay hidden until hover arms the tooltip on its first hover, so a long
 * settled transcript mounts no tooltip roots (and no per-mount ids in the
 * markup the parse cache compares).
 */
export function IconAction({
  label,
  onClick,
  children,
  className,
  disabled,
  armed = true,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  armed?: boolean;
}) {
  const button = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      disabled={disabled}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={onClick}
    />
  );
  if (!armed) return <Button {...button.props}>{children}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={button}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Arms a hover group's tooltips when the pointer first enters it. Not on
 *  focus: arming swaps the button's element, which would drop the focus;
 *  a keyboard reader has the button's name. */
export function useArmOnIntent(): [boolean, { onPointerEnter: () => void }] {
  const [armed, setArmed] = useState(false);
  return [armed, { onPointerEnter: () => setArmed(true) }];
}
