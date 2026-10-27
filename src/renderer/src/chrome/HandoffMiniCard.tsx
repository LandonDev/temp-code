import { ChevronRight, Replace } from "./icons";
import { HARNESS_TITLE, type HarnessId } from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../components/ui/attachment";
import { MiniCardRemove } from "./MiniCardRemove";

type Card = {
  from: HarnessId;
  to: HarnessId;
  request?: string;
  files?: number;
};

type Props = {
  card: Card;
  onDismiss?: () => void;
};

/** A handoff between harnesses: from and to, then the request and how
 *  many files travel with it. */
export function HandoffMiniCard({ card, onDismiss }: Props) {
  const files =
    card.files != null && card.files > 0
      ? `${card.files} ${card.files === 1 ? "file" : "files"}`
      : null;

  return (
    <div className="px-3 pt-2">
      <Attachment size="sm">
        <AttachmentMedia>
          <Replace className="size-3.5" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle className="flex items-center gap-1.5">
            <HarnessIcon harness={card.from} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{HARNESS_TITLE[card.from]}</span>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            <HarnessIcon harness={card.to} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{HARNESS_TITLE[card.to]}</span>
          </AttachmentTitle>
          {card.request || files ? (
            <AttachmentDescription className="flex gap-3">
              {card.request ? <span className="min-w-0 truncate">{card.request}</span> : null}
              {files ? <span className="shrink-0 tabular-nums">{files}</span> : null}
            </AttachmentDescription>
          ) : null}
        </AttachmentContent>
        {onDismiss ? <MiniCardRemove label="Remove handoff" onDismiss={onDismiss} /> : null}
      </Attachment>
    </div>
  );
}
