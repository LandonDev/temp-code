import type { AgentsCue } from "../lib/threads/agents";
import { AgentsCueView } from "./AgentsCue";
import { ThreadMenu } from "./ThreadMenu";

/**
 * The title bar's end group drawn with no store, for `bun run ui:preview
 * src/renderer/src/chrome/AgentsCue.preview.tsx#AgentsCueEndGroup` and the
 * dom test that keeps the fixtures honest: the agents cue (when one is
 * live), then ⋯ and Panel as ThreadHeader builds them. Rendered by nothing
 * in the app.
 */
export function AgentsCueEndGroup({
  cue,
  pressed = false,
  room,
}: {
  cue: AgentsCue | null;
  pressed?: boolean;
  room?: boolean;
}) {
  return (
    <div className="flex h-10 items-center justify-end bg-sidebar">
      <div className="flex shrink-0 items-center gap-0.5">
        {cue ? <AgentsCueView cue={cue} pressed={pressed} room={room} onClick={() => {}} /> : null}
        <ThreadMenu
          host={null}
          cost={null}
          rows={[]}
          onPick={() => {}}
          running={0}
          onPauseAll={() => Promise.resolve()}
          terminal={{ active: false }}
          recent={[]}
          onOpenRecent={() => {}}
          archived={[]}
          onRestore={() => {}}
          panel={{ open: pressed, room, onToggle: () => {} }}
        />
      </div>
    </div>
  );
}
