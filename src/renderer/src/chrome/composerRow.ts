/**
 * A control in the quiet rows around the composer's box (the draft row over
 * it, ComposerBar's row under it): 12px muted text, the hover and open fill
 * at foreground/5 over `--dur-hover`, the text stepping to foreground, and a
 * press that steps the fill to foreground/12 at once, as every row presses.
 * The model button, the context meter, the permission mode and every
 * draft-row picker share it; their own 24px size comes from `xs` (a Button)
 * or the select's override in AccessPicker.
 */
export const ROW_CONTROL =
  "text-xs font-normal text-muted-foreground transition-[background-color,color] duration-(--dur-hover) ease-(--ease-out) hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-foreground/5 aria-expanded:text-foreground data-popup-open:bg-foreground/5 data-popup-open:text-foreground active:bg-foreground/12 active:transition-none motion-reduce:transition-none";
