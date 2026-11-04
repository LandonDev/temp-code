/** The one console recipe: a bounded log or text region (a batch step's
 *  output, a job's log, a licence) on the card fill, 12px by 8px inside an
 *  8px radius, 12px mono on 20px lines in the muted ink, and the focus ring,
 *  since it takes `tabIndex={0}` so the keyboard reaches it. The caller adds
 *  its height cap, overflow and wrapping. */
export const CONSOLE =
  "rounded-lg [--scrollbar-inset:var(--radius-lg)] bg-card px-3 py-2 font-mono text-xs leading-5 text-muted-foreground focus-ring";
