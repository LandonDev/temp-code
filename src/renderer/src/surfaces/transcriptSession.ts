import { createContext, useContext } from "react";
import { sessionStore } from "../lib/tcserver/store";

/** The session a transcript renders, for rows that key state by session. */
export const TranscriptSessionContext = createContext<string | undefined>(undefined);

export function useTranscriptSession(): string | undefined {
  return useContext(TranscriptSessionContext);
}

/** The host the transcript's thread runs on; undefined outside a transcript. */
export function useTranscriptHost(): string | undefined {
  const sessionId = useTranscriptSession();
  return sessionId ? sessionStore.environmentOf(sessionId) : undefined;
}
