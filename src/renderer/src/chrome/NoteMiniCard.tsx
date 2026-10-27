import { StickyNote } from "./icons";
import { noteSourceProject, type NoteCardMeta } from "../lib/notes";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../components/ui/attachment";
import { MiniCardRemove } from "./MiniCardRemove";

type Props = {
  card: NoteCardMeta;
  onDismiss?: () => void;
  embedded?: boolean;
};

/** A note on its way into a turn: its title and the project it came from
 *  (embedded in a sent message, the title alone). */
export function NoteMiniCard({ card, onDismiss, embedded = false }: Props) {
  const project = embedded ? null : noteSourceProject(card.sourceCwd);
  const title = card.title || "Untitled";
  const inner = (
    <Attachment size="sm">
      <AttachmentMedia>
        <StickyNote className="size-3.5" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
        {project ? <AttachmentDescription>{project}</AttachmentDescription> : null}
      </AttachmentContent>
      {onDismiss ? <MiniCardRemove label={`Remove note ${title}`} onDismiss={onDismiss} /> : null}
    </Attachment>
  );
  if (embedded) return inner;
  return <div className="px-3 pt-2">{inner}</div>;
}
