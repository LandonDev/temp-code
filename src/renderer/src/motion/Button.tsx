import {
  AnimatePresence,
  type HTMLMotionProps,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  forwardRef,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { EASE_OUT, SPRING_PRESS } from "../lib/ease";
import { cn } from "./cn";

/**
 * The pressable: scales to 0.96 on tap on a quick spring (hover changes
 * colour only) and can spawn a short ripple from the press point. Under
 * reduced motion the press is a wash instead of a scale.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressScale?: number;
  /** Spawn a Material-style ripple from the press point. Off by default. */
  ripple?: boolean;
  children?: ReactNode;
}

export interface ButtonLinkProps extends Omit<HTMLMotionProps<"a">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressScale?: number;
  children?: ReactNode;
}

type Ripple = { id: number; x: number; y: number; size: number };

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent/90",
  secondary: "border border-content/10 bg-content/8 text-content hover:bg-content/10",
  ghost: "text-content/70 hover:bg-content/8 hover:text-content",
  outline: "border border-content/10 bg-transparent text-content hover:bg-content/5",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
  md: "h-8 gap-2 rounded-md px-3.5 text-[13px]",
  lg: "h-10 gap-2 rounded-lg px-5 text-sm",
  icon: "size-7 rounded-md",
};

const BASE_CLASS =
  "inline-flex select-none items-center justify-center font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50";
/** Reduced motion keeps a press wash so the tap still answers. */
const REDUCE_CLASS = "active:bg-content/10";

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    pressScale = 0.96,
    ripple = false,
    className,
    children,
    onPointerDown,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const nextId = useRef(0);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (ripple && !reduce) {
        const rect = event.currentTarget.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2;
        const id = nextId.current++;
        setRipples((prev) => [
          ...prev,
          { id, x: event.clientX - rect.left, y: event.clientY - rect.top, size },
        ]);
      }
      onPointerDown?.(event);
    },
    [ripple, reduce, onPointerDown],
  );

  return (
    <motion.button
      ref={ref}
      type="button"
      whileTap={reduce ? undefined : { scale: pressScale }}
      transition={SPRING_PRESS}
      onPointerDown={handlePointerDown}
      className={cn(
        BASE_CLASS,
        reduce && REDUCE_CLASS,
        ripple && "relative overflow-hidden",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {ripple && !reduce ? (
        <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
          <AnimatePresence>
            {ripples.map((r) => (
              <motion.span
                key={r.id}
                className="absolute rounded-full bg-current"
                style={{ left: r.x, top: r.y, width: r.size, height: r.size, x: "-50%", y: "-50%" }}
                initial={{ scale: 0.05, opacity: 0.3 }}
                animate={{ scale: 1, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: EASE_OUT }}
                onAnimationComplete={() =>
                  setRipples((prev) => prev.filter((x) => x.id !== r.id))
                }
              />
            ))}
          </AnimatePresence>
        </span>
      ) : null}
      {children}
    </motion.button>
  );
});

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = "primary", size = "md", pressScale = 0.96, className, children, ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  return (
    <motion.a
      ref={ref}
      whileTap={reduce ? undefined : { scale: pressScale }}
      transition={SPRING_PRESS}
      className={cn(BASE_CLASS, reduce && REDUCE_CLASS, VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      {...rest}
    >
      {children}
    </motion.a>
  );
});
