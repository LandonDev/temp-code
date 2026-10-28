import { createContext, useContext } from "react";
import type { ClockSession } from "../lib/turnClock";
import type { Session } from "../lib/session";
import type { OutcomeSession } from "../lib/turnOutcome";

/** The session slice the transcript needs for timers, error rows and the
 *  watching line of a stripless surface. */
export type TurnSession = ClockSession & OutcomeSession & Partial<Pick<Session, "background" | "activity">>;

export const TurnStateContext = createContext<TurnSession | null>(null);

export function useTurnState(): TurnSession | null {
  return useContext(TurnStateContext);
}
