import { createContext, useContext } from "react";
import type { SpawnedName } from "../agentSteps";

/**
 * A person's hand on an action group: opening a row's body inside it
 * (ActionRow, EditRow) decides the group from then on, as toggling its line
 * does (transcript/ActionGroup.tsx). Null outside a group.
 */
export const GroupHandContext = createContext<(() => void) | null>(null);

/** Tell the group around this row that the person took it over. */
export function useGroupHand(): (() => void) | null {
  return useContext(GroupHandContext);
}

/** The agents the group's spawn calls named (agentSteps.ts `spawnedNames`); empty outside a group. */
export const SpawnedNamesContext = createContext<ReadonlyMap<string, SpawnedName>>(new Map());

/** What the group's spawns named this agent, for a row the store cannot name yet. */
export function useSpawnedName(id: string): SpawnedName | undefined {
  return useContext(SpawnedNamesContext).get(id);
}
