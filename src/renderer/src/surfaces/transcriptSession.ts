import { createContext, useContext } from "react";

/** The session a transcript renders, for rows that key state by session. */
export const TranscriptSessionContext = createContext<string | undefined>(undefined);

export function useTranscriptSession(): string | undefined {
  return useContext(TranscriptSessionContext);
}
