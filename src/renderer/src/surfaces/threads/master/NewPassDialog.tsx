import { useEffect, useRef } from "react";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusMark } from "@renderer/components/ui/status";
import { Modal, useModalClose } from "../../../chrome/Modal";
import { useMetaById, useSessionById } from "../../../lib/threads/agents";
import { useSessionActions, ThreadComposer } from "../../threadChat";
import { passLine } from "./rowBody";
import { useBoardDigest } from "./useMasterModel";

type Props = { sessionId: string; landed: boolean; onClose: () => void };

/**
 * New pass on a board row (docs/LAYOUT.md "Master"): the thread's title,
 * one quiet line with its status and what it is doing or last said, and
 * the same composer its tab has, for that thread on its own host. Send is
 * what the composer would do there: a turn on an idle thread, a steer or
 * the queue on a running one. The dialog closes on send and the row
 * follows the thread's status from the store; Escape (or a click outside)
 * closes it and the draft stays with the thread, as a tab's does.
 */
export function NewPassDialog(props: Props) {
  const meta = useMetaById(props.sessionId);
  if (!meta) return null;
  return (
    <Modal onClose={props.onClose} title={meta.title || "Untitled"} size="lg">
      <Body {...props} />
    </Modal>
  );
}

function Body({ sessionId, landed, onClose }: Props) {
  const meta = useMetaById(sessionId);
  const session = useSessionById(sessionId);
  const actions = useSessionActions();
  const digest = useBoardDigest(sessionId);
  const close = useModalClose();
  const body = useRef<HTMLDivElement>(null);

  // The composer loads after the frame opens, so it cannot be the frame's
  // initial focus; the caret moves into it once it is there.
  const ready = !!session;
  useEffect(() => {
    if (!ready) return;
    const id = requestAnimationFrame(() => body.current?.querySelector<HTMLElement>("[data-composer-input]")?.focus());
    return () => cancelAnimationFrame(id);
  }, [ready]);

  if (!meta) return null;
  const line = passLine(meta, digest, landed);
  return (
    <div ref={body} data-new-pass={sessionId} data-new-pass-host={meta.environmentId}>
      <p className="mt-1 flex h-4 items-center px-4" data-new-pass-line>
        <StatusMark state={line.state} detail={line.detail} />
      </p>
      <div className="px-4 pt-4 pb-4">
        {session ? (
          <ThreadComposer
            session={session}
            actions={actions}
            visible
            focused={false}
            hotkeys={false}
            onFocus={NOOP}
            onOpenDiff={NOOP}
            onSent={() => (close ? close(onClose) : onClose())}
          />
        ) : (
          <Skeleton className="h-[92px] w-full rounded-xl" aria-busy="true" data-new-pass-loading />
        )}
      </div>
    </div>
  );
}

const NOOP = () => {};
