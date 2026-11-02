/**
 * A control in the quiet row under the composer's box (ComposerBar): 12px
 * muted text, the hover and open fill at foreground/5, the text stepping to
 * foreground. The model button, the context meter and the permission mode
 * share it; their own 24px size comes from `xs` (a Button) or the select's
 * override in AccessPicker.
 */
export const ROW_CONTROL =
  "text-xs font-normal text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-foreground/5 aria-expanded:text-foreground data-popup-open:bg-foreground/5 data-popup-open:text-foreground";
