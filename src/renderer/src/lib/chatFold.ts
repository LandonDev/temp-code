import { useCallback, useState } from "react";

/**
 * The board views' chat fold (SplitShell), remembered per thread for the
 * app's run, so a tab switch that unmounts a parked view keeps it. A
 * relaunch starts each view on its phase default again. Every set writes
 * the memory, the views' render-time phase adjusts included. A question
 * waiting at mount opens the chat whatever was remembered: its answer lives
 * there. The third value says whether this mount found a remembered fold.
 */
const folds = new Map<string, boolean>();

type Fold = { id: string; open: boolean; remembered: boolean };

export function useChatFold(id: string, initial: boolean, waiting = false): [boolean, (open: boolean) => void, boolean] {
  const mount = (): Fold => ({ id, open: waiting || (folds.get(id) ?? initial), remembered: folds.has(id) });
  const [state, setState] = useState(mount);
  if (state.id !== id) setState(mount());
  const setOpen = useCallback(
    (open: boolean) => {
      folds.set(id, open);
      setState((prev) => ({ ...prev, id, open }));
    },
    [id],
  );
  const current = state.id === id ? state : mount();
  return [current.open, setOpen, current.remembered];
}

/** Test seam. */
export function resetChatFolds(): void {
  folds.clear();
}
