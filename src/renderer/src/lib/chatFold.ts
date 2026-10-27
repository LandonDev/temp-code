import { useCallback, useState } from "react";

/**
 * The board views' chat fold (SplitShell), remembered per thread for the
 * app's run, so a tab switch that unmounts a parked view keeps it. A
 * relaunch starts each view on its phase default again. Every set writes
 * the memory, the views' render-time phase adjusts included.
 */
const folds = new Map<string, boolean>();

export function useChatFold(id: string, initial: boolean): [boolean, (open: boolean) => void] {
  const [state, setState] = useState(() => ({ id, open: folds.get(id) ?? initial }));
  if (state.id !== id) setState({ id, open: folds.get(id) ?? initial });
  const setOpen = useCallback(
    (open: boolean) => {
      folds.set(id, open);
      setState({ id, open });
    },
    [id],
  );
  return [state.id === id ? state.open : (folds.get(id) ?? initial), setOpen];
}

/** Test seam. */
export function resetChatFolds(): void {
  folds.clear();
}
