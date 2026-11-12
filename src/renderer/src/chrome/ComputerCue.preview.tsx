import type { ComputerCue } from "../lib/computerSection";
import { ComputerCueView } from "./ComputerCue";
import { ThreadMenu } from "./ThreadMenu";

/**
 * The title bar's end group drawn with no store, for `bun run ui:preview
 * src/renderer/src/chrome/ComputerCue.preview.tsx#ComputerCueEndGroup` and
 * the dom test that keeps the fixtures honest: the computer cue (while a
 * session is live), then ⋯ and Panel as ThreadHeader builds them. Rendered
 * by nothing in the app.
 */
export function ComputerCueEndGroup({ cue, pressed = false, room }: { cue: ComputerCue | null; pressed?: boolean; room?: boolean }) {
  return (
    <div className="flex h-10 items-center justify-end bg-sidebar">
      <div className="flex shrink-0 items-center gap-0.5">
        {cue ? <ComputerCueView cue={cue} pressed={pressed} room={room} onClick={() => {}} /> : null}
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
