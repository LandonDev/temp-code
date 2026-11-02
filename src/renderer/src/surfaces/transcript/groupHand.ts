import { createContext, useContext } from "react";

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
