import { CircleDot, GitPullRequest } from "./icons";
import { openUrl } from "../lib/native";
import type { InboxComposerCard } from "../lib/githubTasks";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "../components/ui/attachment";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { MiniCardRemove } from "./MiniCardRemove";

type Props = {
  card: InboxComposerCard;
  onDismiss?: () => void;
};

/** The issue or pull request a draft is about: the kind glyph, the title,
 *  the ref and its repo; a click opens it where it lives. */
export function InboxMiniCard({ card, onDismiss }: Props) {
  const KindIcon = card.kind === "pr" ? GitPullRequest : CircleDot;
  const kindLabel = card.kind === "pr" ? "Pull request" : "Issue";
  const providerLabel = card.provider === "linear" ? "Linear" : "GitHub";

  return (
    <div className="px-3 pt-2">
      <Attachment size="sm">
        <AttachmentMedia>
          <KindIcon className="size-3.5" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{card.title}</AttachmentTitle>
          <AttachmentDescription className="flex gap-3">
            <span className="shrink-0 tabular-nums">{card.identifier}</span>
            {card.source ? <span className="min-w-0 truncate">{card.source}</span> : null}
          </AttachmentDescription>
        </AttachmentContent>
        {card.url ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <AttachmentTrigger
                  aria-label={`Open ${kindLabel} ${card.identifier} in ${providerLabel}`}
                  onClick={() => void openUrl(card.url)}
                />
              }
            />
            <TooltipContent>Open in {providerLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        {onDismiss ? (
          <MiniCardRemove label={`Remove ${kindLabel} ${card.identifier}`} onDismiss={onDismiss} />
        ) : null}
      </Attachment>
    </div>
  );
}
