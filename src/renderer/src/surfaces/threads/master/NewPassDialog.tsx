import { useEffect, useRef } from "react";
import { Modal } from "../../../chrome/Modal";
import { TONE_CLASS, useMetaById, useSessionById } from "../../../lib/threads/agents";
import { useSessionActions, ThreadComposer } from "../../threadChat";
import { StatusGlyph } from "../fleet/rowBits";
import { passLine } from "./rowBody";
import { useBoardDigest } from "./useMasterModel";

/**
 * New pass on a board row (docs/LAYOUT.md "Master"): the thread's title,
 * one quiet line with its status and what it is doing or last said, and
 * the same composer its tab has, for that thread on its own host. Send is
 * what the composer would do there: a turn on an idle thread, a steer or
 * the queue on a running one. The dialog closes on send and the row
 * follows the thread's status from the store; Escape (or a click outside)
 * closes it and the draft stays with the thread, as a tab's does.
 */
export function NewPassDialog({ sessionId, landed, onClose }: { sessionId: string; landed: boolean; onClose: () => void }) {
  const meta = useMetaById(sessionId);
  const session = useSessionById(sessionId);
  const actions = useSessionActions();
  const digest = useBoardDigest(sessionId);
  const body = useRef<HTMLDivElement>(null);

  // The panel lands focus on its close button; the caret belongs in the field.
  const ready = !!session && !!actions;
  useEffect(() => {
    if (!ready) return;
    const id = requestAnimationFrame(() => body.current?.querySelector<HTMLElement>("[data-composer-input]")?.focus());
    return () => cancelAnimationFrame(id);
  }, [ready]);

  if (!meta) return null;
  const line = passLine(meta, digest, landed);
  return (
    <Modal onClose={onClose} title={meta.title || "Untitled"} size="lg">
      <div ref={body} data-new-pass={sessionId} data-new-pass-host={meta.environmentId}>
        <p className="mt-0.5 flex h-4 items-center gap-1.5 px-4 text-[12px] leading-4" data-new-pass-line>
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <StatusGlyph status={meta.status} />
          </span>
          <span className={`min-w-0 truncate ${line.tone === "muted" ? "text-content/50" : TONE_CLASS[line.tone]}`}>{line.text}</span>
        </p>
        <div className="px-2.5 pt-3 pb-2.5">
          {session && actions ? (
            <ThreadComposer
              session={session}
              actions={actions}
              visible
              focused={false}
              hotkeys={false}
              onFocus={NOOP}
              onOpenDiff={NOOP}
              onSent={onClose}
            />
          ) : (
            <div className="h-[92px] rounded-lg border border-content/10 bg-content/5" aria-busy="true" data-new-pass-loading />
          )}
        </div>
      </div>
    </Modal>
  );
}

const NOOP = () => {};
