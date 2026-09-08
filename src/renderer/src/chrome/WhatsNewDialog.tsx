import {
  formatReleaseDate,
  presentReleaseNotes,
  releaseNotesTitle,
  type ReleaseNotesPresentation,
} from "../lib/releaseNotes";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";
import { Modal } from "./Modal";

type Props = {
  version: string;
  /** Notes from the update feed for a version this build does not bundle. */
  markdown?: string;
  onClose: () => void;
};

/**
 * Bundled changelog by default. With `markdown`, the feed's notes: a full
 * changelog section loses its heading like the bundled one, anything else
 * shows as is.
 */
function resolveNotes(
  version: string,
  markdown?: string,
): ReleaseNotesPresentation | null {
  if (markdown == null) return presentReleaseNotes(version);
  return (
    presentReleaseNotes(version, markdown) ?? {
      version,
      date: null,
      markdown: markdown.trim(),
    }
  );
}

export function WhatsNewBody({
  version,
  markdown,
}: {
  version: string;
  markdown?: string;
}) {
  const notes = resolveNotes(version, markdown);
  const title = releaseNotesTitle(version);

  return (
    <article aria-label={title} className="px-5 py-4">
      {notes?.markdown ? (
        <AgentMarkdown
          className="whats-new-md"
          text={notes.markdown}
          streaming={false}
        />
      ) : (
        <p className="text-[13px] text-content/60">
          Release notes for this version are not available in this build.
        </p>
      )}
    </article>
  );
}

export function WhatsNewDialog({ version, markdown, onClose }: Props) {
  const notes = resolveNotes(version, markdown);
  const date = notes?.date ? formatReleaseDate(notes.date) : null;

  return (
    <Modal
      onClose={onClose}
      title="What's new"
      description={`Release ${version}${date ? ` · ${date}` : ""}`}
      size="md"
      className="h-[min(72vh,640px)]"
    >
      <WhatsNewBody version={version} markdown={markdown} />
    </Modal>
  );
}
