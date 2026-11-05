// A preview frame for `bun run ui:preview src/renderer/src/chrome/Composer.preview.tsx#DockedComposerPreview`:
// the docked footer as a thread draws it (the slot above the composer, the
// queue, the box with its attachments and the row under it), on a thread
// that already has a message, so the draft row is gone.
import { newSession, type Attachment, type Block, type Session } from "../lib/session";
import type { QueuedMessage } from "../lib/tcserver/types";
import { sessionStore } from "../lib/tcserver/store";
import { saveComposerDraft } from "../lib/composerDrafts";
import { ChatFooter } from "../surfaces/threads/chatSlots";
import { WorkingStrip } from "../surfaces/threads/WorkingStrip";
import { Composer } from "./Composer";
import { MessageQueue } from "./MessageQueue";

const noop = () => {};

export function DockedComposerPreview({
  id,
  status = "idle",
  elapsedMs = 0,
  draft,
  attachments = [],
  queue = [],
}: {
  /** One thread per fixture: the store and the draft cache are shared. */
  id: string;
  status?: Session["status"];
  elapsedMs?: number;
  draft?: string;
  attachments?: Attachment[];
  queue?: QueuedMessage[];
}) {
  const now = Date.now();
  const session: Session = {
    ...newSession("local", "claude", "/srv/agents/work/temp-code", "claude:opus-5.5"),
    id,
    status,
    ...(status === "running" ? { busy: true, busySince: now - elapsedMs } : {}),
    ...(status === "paused" ? { pausedAt: now, frozenActiveElapsed: elapsedMs } : {}),
    blocks: [{ id: `${id}-u`, role: "user", text: "Rework the login flow" } as Block],
    context: { used: 84_000, window: 200_000 },
  };
  if (!sessionStore.get(id)) sessionStore.mutate((prev) => [...prev, session]);
  if (draft || attachments.length > 0) saveComposerDraft(id, { segments: draft ? [{ text: draft }] : [], attachments });
  return (
    <div className="w-full">
      <ChatFooter
        slots={{
          transcript: null,
          strip: <WorkingStrip session={session} onStop={noop} onResume={noop} />,
          composer: (
            <Composer
              focused={false}
              harness="claude"
              model={session.model}
              runtimeMode="supervised"
              cwd={session.cwd}
              executionCwd={session.cwd}
              sessionId={id}
              recents={[]}
              context={session.context}
              busy={status === "running"}
              paused={status === "paused"}
              onFocus={noop}
              onCwdChange={noop}
              onModelChange={noop}
              onRuntimeModeChange={noop}
              onSubmit={noop}
              topSlot={
                queue.length > 0 ? (
                  <MessageQueue items={queue} paused={status === "paused"} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />
                ) : undefined
              }
            />
          ),
        }}
      />
    </div>
  );
}
