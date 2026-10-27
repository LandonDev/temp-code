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
import { SelectSessionContext } from "../AgentMarkdown";
import { threadMentionParts, type ThreadMentionPart, useThreadTitles } from "../../lib/threadMentions";
import { CopyMessageButton } from "../CopyMessageButton";
import { PreambleRow } from "../PreambleRow";
import { useTranscriptSession } from "../transcriptSession";

/** The send-in entrance's length (transcript.css `bubble-send-flip` and
 *  `bubble-send-in`, the composer send's 280ms on the drawer curve). */
export const SEND_IN_MS = 280;

/**
 * The person's message: a soft bubble on the right, 15px, no avatar and no
 * time. The project rules it opened with fold to one line above it.
 */
export function UserMessageBlock({
  block,
  stickyIndex,
  environmentId,
}: {
  block: Block;
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
    <div className="flex min-w-0 flex-col items-end pt-5 pb-2 pl-10">
      {block.preamble ? (
        <div className="flex max-w-[min(36rem,85%)] justify-end">
          <PreambleRow text={block.preamble.text} words={block.preamble.words} />
        </div>
      ) : null}
      <div
        ref={bubbleRef}
        data-user-bubble=""
        className="group/message relative w-fit max-w-[min(36rem,85%)] min-w-0 rounded-xl bg-card px-3.5 py-2.5 font-sans text-[15px] leading-6 text-foreground"
        style={
          entering == null
            ? { zIndex: stickyIndex }
            : { zIndex: stickyIndex, animationDelay: `${-entering}ms` }
        }
        onAnimationEnd={entering == null ? undefined : settleEntrance}
        onClick={overflows ? toggle : undefined}
      >
        {text || block.attachments?.length ? (
          <CopyMessageButton text={text} attachments={block.attachments ?? []} />
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
        {text ? (
          <pre
            ref={textRef}
            className={`min-w-0 whitespace-pre-wrap break-words font-sans ${expanded ? "" : "line-clamp-4"}`}
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
