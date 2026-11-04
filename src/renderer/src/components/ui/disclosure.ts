/** The one disclosure chevron's motion: a ChevronRight that turns `rotate-90`
 *  while its fold is open, with the fold, on `--dur-base`. A plain module, so
 *  the first paint can use it without Base UI's collapsible
 *  (collapsible.tsx re-exports it). */
export const DISCLOSURE_CHEVRON = "transition-transform duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none";
