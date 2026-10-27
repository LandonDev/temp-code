import { useLockOverscroll } from "../hooks/useLockOverscroll";
import type { ReleaseNotesTabSource } from "../lib/releaseNotes";
import { releaseNotesMarkdown } from "../lib/releaseNotesParse";

/** App asks for a version's notes through this chunk (`releaseNotesChunk.load()`). */
export { releaseNotesForVersion } from "../lib/releaseNotesParse";
import { AgentMarkdown } from "./AgentMarkdown";
import { EmptyState } from "./SurfaceSkeleton";

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
          <EmptyState title="No release notes for this version" />
        )}
      </article>
    </div>
  );
}
