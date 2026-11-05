/** A pressable row's fill (DESIGN.md "Motion values": press and hover): it
 *  hovers at foreground/5 over `--dur-hover` and steps to foreground/12 at
 *  once on a press, easing back over `--dur-hover` on release; nothing
 *  scales. A plain module, so the first paint can use it. */
export const ROW_PRESS =
  "transition-[background-color] duration-(--dur-hover) ease-(--ease-out) hover:bg-foreground/5 active:bg-foreground/12 active:transition-none motion-reduce:transition-none";

/** A row with controls of its own (README `ItemButton`): a plain container
 *  whose open control is an `ItemButton` laid over the whole row
 *  (`ROW_OPEN`, `data-row-open`), its own buttons positioned siblings above
 *  it and what it shows above it with no pointer (`ROW_SHOWS`), so no button
 *  holds a button and the ring draws round the whole row. The row hovers at
 *  /5 and steps to /12 while its open control is pressed, never while one of
 *  its own buttons is. */
export const ROW_HOLDS =
  "relative transition-[background-color] duration-(--dur-hover) ease-(--ease-out) hover:bg-foreground/5 has-[>[data-row-open]:active]:bg-foreground/12 has-[>[data-row-open]:active]:transition-none motion-reduce:transition-none";
/** The row's open control, laid over the whole row. */
export const ROW_OPEN = "absolute inset-0 h-auto w-auto rounded-[inherit] border-0 p-0 hover:bg-transparent active:bg-transparent";
/** What the row shows, over its open control: no pointer of its own. */
export const ROW_SHOWS = "pointer-events-none relative";
/** One of the row's own controls, above its open control. */
export const ROW_CONTROLS = "relative";
