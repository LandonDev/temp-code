// A8 (action rows): the one grid every step of the agent's work sits on.
import { createContext } from "react";

/**
 * A step's line, left to right, each slot drawn only when it has something,
 * 8px apart: the 14px glyph (`GLYPH_SLOT`), the verb in the muted ink, the
 * target in foreground (it truncates first), the counts at the text's size,
 * the row's extras, the chevron. The glyph box is fixed, so verbs line up and
 * each target starts where its verb ends, as in Claude.
 *
 * 13px on 20px lines in a 28px row at the prose's edge; 26px hung in an open
 * group's list, which says so with `data-hung` (ActionGroup).
 */
export const STEP_LINE = "flex h-7 in-data-[hung]:h-6.5 min-w-0 items-center gap-2 font-sans text-[13px] leading-5";

/** A notice's line, which can wrap: the same height, as a minimum (3 + 20 + 3 hung). */
export const STEP_NOTICE = "min-h-7 py-1 in-data-[hung]:min-h-6.5 in-data-[hung]:py-[3px]";

/** The 14px glyph slot every step leads with. */
export const GLYPH_SLOT = "grid size-3.5 shrink-0 place-items-center text-muted-foreground";

/**
 * True around a host step folded into a run (ActivityRow): its notice line
 * reads verb then target like a call, the lead muted and the first detail in
 * foreground.
 */
export const StepRowContext = createContext(false);
