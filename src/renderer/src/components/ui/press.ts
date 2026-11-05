/** A pressable row's fill (DESIGN.md "Motion values": press and hover): it
 *  hovers at foreground/5 over `--dur-hover` and steps to foreground/12 at
 *  once on a press, easing back over `--dur-hover` on release; nothing
 *  scales. A plain module, so the first paint can use it. */
export const ROW_PRESS =
  "transition-[background-color] duration-(--dur-hover) ease-(--ease-out) hover:bg-foreground/5 active:bg-foreground/12 active:transition-none motion-reduce:transition-none";
