import { createContext, useContext } from "react";
import type { ClockSession } from "../lib/turnClock";
import type { OutcomeSession } from "../lib/turnOutcome";

/** The session slice the transcript needs for timers and error rows. */
export type TurnSession = ClockSession & OutcomeSession;

export const TurnStateContext = createContext<TurnSession | null>(null);

export function useTurnState(): TurnSession | null {
  return useContext(TurnStateContext);
}
