// A8 (action rows): the one grid every step of the agent's work sits on.
import { createContext } from "react";

/**
 * A step's line, left to right, each slot drawn only when it has something:
 * the 14px glyph (`GLYPH_SLOT`), the verb in the muted ink, the target in
 * foreground (it truncates first), the counts at the text's size, the row's
 * extras, the chevron. The glyph sits 8px from the verb (its own `me-1` on the
 * line's 4px), each word, count or tally 4px from the next, and the extras and
 * the chevron 8px after the last value (`ms-1`). The glyph box is fixed, so
 * verbs line up and each target starts where its verb ends, as in Claude.
 *
 * 13px on 20px lines in a 28px row at the prose's edge. In an open group's
 * table (ActionGroup's `data-table`: one hairline frame, 12px radius, rules
 * between rows, as Claude's) a row is 32px, its words inset 12px: our 20px
 * line and 6px above and below, a step looser than the prose's 28px line.
 */
export const STEP_LINE = "flex h-7 in-data-[table]:h-8 in-data-[table]:px-3 min-w-0 items-center gap-1 font-sans text-[13px] leading-5";

/** A notice's line, which can wrap: the same height, as a minimum (4 + 20 + 4; 6 + 20 + 6 in a table). */
export const STEP_NOTICE = "min-h-7 py-1 in-data-[table]:min-h-8 in-data-[table]:py-1.5 in-data-[table]:px-3";

/** What opens under a row in a table: no frame of its own, across the row's
 *  width under one hairline, its content at the row's 12px inset with 8px
 *  above and below. Outside a table the caller's own inset stands. */
export const TABLE_BODY = "in-data-[table]:border-t in-data-[table]:border-border in-data-[table]:px-3 in-data-[table]:py-2";

/** The 14px glyph slot every step leads with, 8px from its verb. */
export const GLYPH_SLOT = "me-1 grid size-3.5 shrink-0 place-items-center text-muted-foreground";

/**
 * True around a host step folded into a run (ActivityRow): its notice line
 * reads verb then target like a call, the lead muted and the first detail in
 * foreground.
 */
export const StepRowContext = createContext(false);
