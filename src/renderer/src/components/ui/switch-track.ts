/** The switch's 32×18 track and its thumb, shared by `Switch` (switch.tsx)
 *  and the rail's Away row (chrome/AwayRow.tsx), which draws a still track
 *  inside its own button. The track carries `data-on`; the thumb slides on a
 *  clip-path (`.t-toggle` in components.css) and snaps under reduced motion.
 *  The on fill is the caller's: `SWITCH_ON` for a setting, the warning tone
 *  for Away. */
export const SWITCH_TRACK =
  "t-toggle group/switch relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent data-[on=false]:bg-input";

export const SWITCH_THUMB =
  "t-toggle-thumb pointer-events-none ms-px block h-3.5 rounded-full bg-background group-data-[on=false]/switch:bg-foreground/80";

/** A setting's on state: the primary fill, its ink on the thumb. */
export const SWITCH_ON = { track: "data-[on=true]:bg-primary", thumb: "group-data-[on=true]/switch:bg-primary-foreground" };
