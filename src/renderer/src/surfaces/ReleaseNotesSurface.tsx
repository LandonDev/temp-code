import { useLockOverscroll } from "../hooks/useLockOverscroll";
import {
  releaseNotesMarkdown,
  type ReleaseNotesTabSource,
} from "../lib/releaseNotes";
import { FileText } from "../chrome/icons";
import { AgentMarkdown } from "./AgentMarkdown";

export function ReleaseNotesSurface({
  source,
}: {
  source: ReleaseNotesTabSource;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const markdown = releaseNotesMarkdown(source);

  return (
    <div
      ref={lockOverscroll}
      className="h-full overflow-y-auto overscroll-none"
    >
      <article
        aria-label="Release notes"
        className="mx-auto w-full max-w-3xl px-8 py-8"
      >
        {markdown ? (
          <AgentMarkdown text={markdown} streaming={false} />
        ) : (
          <div className="flex flex-col items-center justify-center px-4 py-24 text-center">
            <FileText className="mb-3 size-6 text-content/30" strokeWidth={1.75} />
            <p className="text-[13px] text-content/40">No release notes for this version</p>
          </div>
        )}
      </article>
    </div>
  );
}
