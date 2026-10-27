import { ChevronRight } from "./icons";
import { HARNESS_TITLE, type SecondOpinionMeta } from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";

type Props = {
  card: SecondOpinionMeta;
};

/** A handoff's header inside its bubble: from one harness to the other. A
 *  second opinion is a notice line (transcript/UserMessage.tsx). */
export function SecondOpinionCard({ card }: Props) {
  const files =
    card.files != null && card.files > 0
      ? `${card.files} ${card.files === 1 ? "file" : "files"}`
      : null;

  return (
    <div className="min-w-0 font-sans">
      <div className="text-[13px] font-medium leading-snug text-foreground">
        Handoff
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
        <HarnessIcon harness={card.from} className="size-3 shrink-0" />
        <span className="truncate">{HARNESS_TITLE[card.from]}</span>
        <ChevronRight
          className="size-3 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
        <HarnessIcon harness={card.to} className="size-3 shrink-0" />
        <span className="truncate">{HARNESS_TITLE[card.to]}</span>
      </div>
      {files ? (
        <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
          {files}
        </div>
      ) : null}
    </div>
  );
}
