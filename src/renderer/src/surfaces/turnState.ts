import { createContext, useContext } from "react";
import type { ClockSession } from "../lib/turnClock";
import type { Session } from "../lib/session";
import type { OutcomeSession } from "../lib/turnOutcome";

/** The session slice the transcript needs for timers, error rows and the
 *  watching line of a stripless surface. */
export type TurnSession = ClockSession & OutcomeSession & Partial<Pick<Session, "background" | "activity">>;

export const TurnStateContext = createContext<TurnSession | null>(null);

/** Whether the transcript is parking a prompt the person just sent (prompt
 *  to top), asked when a bubble decides its entrance: a parked bubble rides
 *  with the content and rises; a followed one may fly from the field. */
export const ParkPendingContext = createContext<() => boolean>(() => false);

export function useTurnState(): TurnSession | null {
  return useContext(TurnStateContext);
}
