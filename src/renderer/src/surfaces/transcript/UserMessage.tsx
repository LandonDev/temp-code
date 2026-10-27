// A7 (turn structure): the person's message.
import { MessageSquare } from "../../chrome/icons";
import {
  type AnimationEvent,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AttachmentChip, openAttachmentImages } from "../../chrome/AttachmentChip";
import { SecondOpinionCard } from "../../chrome/SecondOpinionCard";
import { NoteMiniCard } from "../../chrome/NoteMiniCard";
import { sendOffset, sendOrigin } from "../../lib/sendOrigin";
import { type Block } from "../../lib/session";
import { CommandChip } from "../ToolChips";
import { commandParts, useKnownCommands, type CommandPart } from "../toolMarks";
import type { TranscriptLayout } from "../../lib/appearance";
import { SelectSessionContext } from "../AgentMarkdown";
import { threadMentionParts, type ThreadMentionPart, useThreadTitles } from "../../lib/threadMentions";
import { CopyMessageButton } from "../CopyMessageButton";
import { PreambleRow } from "../PreambleRow";
import { useTranscriptSession } from "../transcriptSession";

/** The send-in entrance's length (index.css `bubble-send-flip`, the
 *  longer of the two entrances). */
export const SEND_IN_MS = 420;

export function UserMessageBlock({
  block,
  layout,
  stickyIndex,
  environmentId,
}: {
  block: Block;
  layout: TranscriptLayout;
  stickyIndex: number;
  /** The host the turn's attachments live on. */
  environmentId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLPreElement>(null);
  // How far into its entrance this bubble is at mount; null once it is
  // over (or was never this window's send). A negative delay resumes it.
  const [entering, setEntering] = useState<number | null>(() => {
    const age = block.born == null ? Infinity : Date.now() - block.born;
    return age < SEND_IN_MS ? age : null;
  });
  // The entrance, decided once from the bubble's rest box on the frame
  // before its first paint — after the scroll engine has parked the turn,
  // whose layout effects run after this child's: a transform-only slide
  // from the composer field (`bubble-send-flip`), else the plain 18px
  // rise. Applied straight to the element so no React render sits between
  // the measurement and the first frame; the class comes off at
  // animationend, and `entrance` stays "" so re-renders leave it alone.
  const bubbleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (entering == null) return;
    const el = bubbleRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      // One screen of travel at most: the turn parks at the top of the
      // transcript, so the flight from the field is about the window's
      // height. Both boxes are on screen, so it can never be more.
      const cap = Math.max(600, window.innerHeight);
      const offset = sendOffset(sendOrigin(), el.getBoundingClientRect(), cap);
      if (offset) {
        el.style.setProperty("--send-dx", `${offset.dx}px`);
        el.style.setProperty("--send-dy", `${offset.dy}px`);
      }
      el.classList.add(offset ? "bubble-send-flip" : "bubble-send-in");
    });
    return () => cancelAnimationFrame(frame);
    // Mount only: the entrance is decided once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const settleEntrance = (e: AnimationEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove("bubble-send-flip", "bubble-send-in");
    e.currentTarget.style.removeProperty("--send-dx");
    e.currentTarget.style.removeProperty("--send-dy");
    setEntering(null);
  };
  const card = block.secondOpinion;
  const note = block.noteCard;
  const text = card && card.kind !== "handoff" ? "" : block.text;
  const chat = layout === "chat";

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !text) {
      setOverflows(false);
      return;
    }
    if (expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  const toggle = () => {
    if (overflows) setExpanded((value) => !value);
  };

  return (
    <div
      className={
        chat ? "flex justify-end pt-1.5 pl-10" : "pt-1.5"
      }
    >
      <div
        ref={bubbleRef}
        className={`group/message relative min-w-0 bg-content/10 px-3 py-2 font-sans text-content ${
          chat
            ? "w-fit max-w-xl rounded-xl"
            : "rounded-xl"
        }`}
        style={
          entering == null
            ? { zIndex: stickyIndex }
            : { zIndex: stickyIndex, animationDelay: `${-entering}ms` }
        }
        onAnimationEnd={entering == null ? undefined : settleEntrance}
        onClick={overflows ? toggle : undefined}
      >
        {text || block.attachments?.length ? (
          <CopyMessageButton text={text} attachments={block.attachments ?? []} chat={chat} />
        ) : null}
        {block.attachments?.length ? (
          <div
            className={`flex flex-wrap gap-1.5 ${text || card || note ? "mb-2" : ""}`}
          >
            {block.attachments.map((file) => (
              <AttachmentChip
                key={file.id}
                environmentId={environmentId}
                attachment={file}
                onOpen={
                  file.kind === "image"
                    ? () => openAttachmentImages(environmentId, block.attachments ?? [], file)
                    : undefined
                }
              />
            ))}
          </div>
        ) : null}
        {note ? (
          <div className={text || card ? "mb-2" : ""}>
            <NoteMiniCard card={note} embedded />
          </div>
        ) : null}
        {card ? (
          <div className={text ? "mb-1.5" : undefined}>
            <SecondOpinionCard card={card} />
          </div>
        ) : null}
        {block.preamble ? (
          <PreambleRow text={block.preamble.text} words={block.preamble.words} />
        ) : null}
        {text ? (
          <pre
            ref={textRef}
            className={`min-w-0 whitespace-pre-wrap break-words font-sans text-sm ${expanded ? "" : "line-clamp-4"}`}
          >
            <UserText text={text} />
          </pre>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A user's words, with each `@thread:<id>` as a chip that opens the thread
 * and each `/command` the session knows as the addon it names.
 */
export function UserText({ text }: { text: string }) {
  const titleOf = useThreadTitles(text);
  const commands = useKnownCommands(useTranscriptSession());
  const onSelectSession = useContext(SelectSessionContext);
  const parts: (ThreadMentionPart | CommandPart)[] = threadMentionParts(text, titleOf).flatMap(
    (part): (ThreadMentionPart | CommandPart)[] => ("id" in part ? [part] : commandParts(part.text, commands)),
  );
  if (parts.length === 1 && "text" in parts[0]) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        "id" in part ? (
          <button
            key={index}
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-content/10 px-1 align-baseline text-[13px] text-content hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              onSelectSession?.(part.id);
            }}
          >
            <MessageSquare className="size-3 opacity-60" />
            {part.title}
          </button>
        ) : "command" in part ? (
          <CommandChip key={index} command={part.command} />
        ) : (
          part.text
        ),
      )}
    </>
  );
}

export const stampFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** When the prompt went out, shown under it while the turn is hovered.
 *  The row is reserved even without a time, so every bubble sits the same
 *  16px above what follows. */
export function TurnStamp({ ts, chat }: { ts?: number; chat: boolean }) {
  return (
    <div
      className={`flex h-4 items-center font-sans text-[11px] tabular-nums text-content/40 opacity-0 transition-opacity group-hover/turn:opacity-100 ${
        chat ? "justify-end" : ""
      }`}
    >
      {ts == null ? null : stampFormat.format(ts)}
    </div>
  );
}
