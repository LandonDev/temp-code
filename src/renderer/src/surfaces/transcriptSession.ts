import { createContext, useContext } from "react";
import { registry } from "../lib/connection";
import { sessionStore } from "../lib/tcserver/store";
import { LEAD_LOCAL_MS, LEAD_REMOTE_MS } from "./smoothText";

/** The session a transcript renders, for rows that key state by session. */
export const TranscriptSessionContext = createContext<string | undefined>(undefined);

/** The row was born live: it joined the live turn after the transcript
 *  opened, so its prose reveals from its first word (AgentTranscript). */
export const RowBornContext = createContext(false);

export function useTranscriptSession(): string | undefined {
  return useContext(TranscriptSessionContext);
}

/** The host the transcript's thread runs on; undefined outside a transcript. */
export function useTranscriptHost(): string | undefined {
  const sessionId = useTranscriptSession();
  return sessionId ? sessionStore.environmentOf(sessionId) : undefined;
}

/** The streaming reveal's seed lead for the transcript's thread: a thread
 *  on another host starts with the lead that covers the link's jitter. */
export function useRevealLead(): number {
  const host = useTranscriptHost();
  return host && host !== registry.primaryEnvironmentId ? LEAD_REMOTE_MS : LEAD_LOCAL_MS;
}
