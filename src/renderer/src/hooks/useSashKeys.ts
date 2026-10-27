import { useCallback, type KeyboardEvent } from "react";

/** Arrow steps as a share of the resized container; Shift takes the larger step. */
export const SASH_STEP = 0.02;
export const SASH_BIG_STEP = 0.1;

type Options = {
  label: string;
  orientation: "vertical" | "horizontal";
  value: number;
  min?: number;
  max?: number;
  /** Container size in the same unit as value (100 for a percentage). */
  getSpan: (handle: HTMLElement) => number;
  /** A left or top edge grows its pane toward the preceding arrow. */
  direction?: 1 | -1;
  onChange: (value: number) => void;
  onReset: () => void;
};

/** Shared focus, ARIA, arrow steps and reset for every resize handle. */
export function useSashKeys({ label, orientation, value, min, max, getSpan, direction = 1, onChange, onReset }: Options) {
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const vertical = orientation === "vertical";
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forward = vertical ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    const span = getSpan(event.currentTarget);
    if (!Number.isFinite(span) || span <= 0) return;
    const step = span * (event.shiftKey ? SASH_BIG_STEP : SASH_STEP);
    const next = value + (event.key === forward ? step : -step) * direction;
    onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)));
  }, [orientation, value, min, max, getSpan, direction, onChange]);

  return {
    role: "separator" as const,
    tabIndex: 0,
    "aria-label": label,
    "aria-orientation": orientation,
    "aria-valuenow": Math.round(value),
    "aria-valuemin": min,
    "aria-valuemax": max,
    onKeyDown,
    onDoubleClick: onReset,
  };
}
