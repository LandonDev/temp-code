import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onAwayPush, startAway } from "../lib/away";
import { dialogsChunk } from "../surfaces/chunks";
import { AWAY_RETURN_TOAST, createAwayReturn, returnLine, type AwayDecidedThread } from "./awayReturnModel";
import { loadToast } from "./toastSync";

/** The list rides the dialogs chunk, mounted only while open. */
const AwayReviewDialog = dialogsChunk.surface("AwayReviewDialog");

/** The toast waits a while: the person just came back to it. */
const RETURN_TOAST_MS = 8_000;

type Props = {
  /** Opens a thread the list names. */
  onOpen: (sessionId: string, environmentId: string) => void;
};

/**
 * Back from Away: one toast, "Decided without you in 4 threads", with
 * Review, which opens the list of those threads. Mounted once with the
 * app's toasts (App.tsx); nothing when no thread decided anything.
 */
export function AwayReturn({ onOpen }: Props) {
  const [review, setReview] = useState<AwayDecidedThread[] | null>(null);
  const open = useRef(onOpen);
  useLayoutEffect(() => {
    open.current = onOpen;
  });
  useEffect(() => {
    startAway();
    const gather = createAwayReturn((threads) => {
      void loadToast().then((toast) =>
        toast(returnLine(threads.length), {
          id: AWAY_RETURN_TOAST,
          duration: RETURN_TOAST_MS,
          action: { label: "Review", onClick: () => setReview(threads) },
        }),
      );
    });
    return onAwayPush(gather);
  }, []);
  if (!review) return null;
  return (
    <AwayReviewDialog
      threads={review}
      onOpen={(sessionId, environmentId) => open.current(sessionId, environmentId)}
      onClose={() => setReview(null)}
    />
  );
}
