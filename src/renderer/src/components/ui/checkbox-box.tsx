/** The checkbox's box and its check, shared by `Checkbox` (checkbox.tsx, on
 *  Base UI) and the still box a first-paint control draws until the select
 *  chunk lands (chrome/MasterCheck.tsx), so the swap moves nothing. The
 *  check draws itself in on `aria-checked` (`.t-check` in components.css). */
export const CHECKBOX_BOX =
  "t-check peer relative flex size-4 shrink-0 items-center justify-center border border-input bg-transparent after:absolute after:-inset-x-3 after:-inset-y-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground focus-ring";

export type CheckboxShape = "square" | "round";

export const CHECKBOX_SHAPES: Record<CheckboxShape, string> = { square: "rounded-[4px]", round: "rounded-full" };

export const CHECKBOX_INDICATOR = "grid place-content-center text-current";

export function CheckMark() {
  return (
    <svg viewBox="-0.3 -0.3 11 8.6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3">
      <path d="M1 4L3.8 7L9.4 1" />
    </svg>
  );
}
