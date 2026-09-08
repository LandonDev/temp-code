import { createContext, useContext } from "react";

/**
 * How a transcript row opens a subagent's transcript in this pane: the
 * views that host M5c's `AgentDetail` overlay provide their setter, so a
 * nested agent row opens the same panel a fleet row does. Without a
 * provider the row falls back to opening the agent's thread.
 */
export const OpenAgentDetailContext = createContext<((agentId: string) => void) | null>(null);

export function useOpenAgentDetail(): ((agentId: string) => void) | null {
  return useContext(OpenAgentDetailContext);
}
