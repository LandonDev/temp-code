import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { forwardRef, type ReactNode } from "react";
import { Check, LoaderCircle, X } from "../chrome/icons";
import { EASE_OUT } from "../lib/ease";
import { Button, type ButtonProps } from "./Button";

/**
 * A button with four states — idle, loading, success, error. The label
 * crossfades (150 ms, opacity only) inside a footprint sized by the widest
 * state, so the row never reflows while a save is in flight.
 */

export type ButtonState = "idle" | "loading" | "success" | "error";

export interface StatefulButtonProps extends Omit<ButtonProps, "children"> {
  state?: ButtonState;
  children: ReactNode;
  loadingText?: ReactNode;
  successText?: ReactNode;
  errorText?: ReactNode;
  icon?: ReactNode;
}

const SWAP = { duration: 0.15, ease: EASE_OUT } as const;

export const StatefulButton = forwardRef<HTMLButtonElement, StatefulButtonProps>(
  function StatefulButton(
    {
      state = "idle",
      children,
      loadingText = "Loading",
      successText = "Done",
      errorText = "Try again",
      icon,
      disabled,
      ...rest
    },
    ref,
  ) {
    const reduce = useReducedMotion();
    const isBusy = state === "loading";
    const faces: Record<ButtonState, ReactNode> = {
      idle: (
        <>
          {children}
          {icon}
        </>
      ),
      loading: (
        <>
          <LoaderCircle className="size-3.5 motion-safe:animate-spin" strokeWidth={2} />
          {loadingText}
        </>
      ),
      success: (
        <>
          <Check className="size-3.5" strokeWidth={2.25} />
          {successText}
        </>
      ),
      error: (
        <>
          <X className="size-3.5" strokeWidth={2} />
          {errorText}
        </>
      ),
    };

    return (
      <Button ref={ref} disabled={disabled || isBusy} aria-busy={isBusy} {...rest}>
        {/* The grid stacks every face in one cell: the widest sets the
            footprint, the current one is the only visible layer. */}
        <span aria-live="polite" className="grid place-items-center">
          {(Object.keys(faces) as ButtonState[]).map((key) => (
            <span
              key={key}
              aria-hidden
              className="invisible col-start-1 row-start-1 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              {faces[key]}
            </span>
          ))}
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={state}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduce ? { duration: 0 } : SWAP}
              className="col-start-1 row-start-1 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              {faces[state]}
            </motion.span>
          </AnimatePresence>
        </span>
      </Button>
    );
  },
);
