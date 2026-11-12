import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { FADE_IN } from "../components/ui/reveal";
import { StatusMark } from "../components/ui/status";
import { useComputerCue, type ComputerCue as Cue } from "../lib/computerSection";
import { NO_ROOM_LABEL, rightPanel, useRightPanel, useShownSection, useShownThreadId } from "../lib/rightPanel";
import { MorphText } from "../motion/MorphText";
import { computerChunk } from "../surfaces/chunks";
import { ROW_CONTROL } from "./composerRow";

/**
 * The title bar's computer cue (docs/LAYOUT.md "Titlebar"), beside the
 * agents cue: while a computer session this desktop can draw is live in the
 * thread on screen's tree, a quiet 24px control: the state's glyph, then
 * "Using TextEdit", or "Needs you" in amber while a card waits, or "Waiting
 * for the Mac" while a step is held. It opens the right panel on Computer
 * and, pressed, closes it again; nothing opens on its own. Working draws the
 * still dot: the thread's own turn already spins. It fades in on
 * `--dur-fast` and leaves at once, so no dead control stays under the
 * pointer; once there, a change of words morphs. It reads the live rows
 * alone, so it needs no panel mounted, and it never shows where the section
 * cannot draw (the browser, a Linux desktop, a box thread driving another
 * Mac): there the session's row is Activity's.
 */
export function ComputerCueView({
  cue,
  pressed,
  room,
  onClick,
}: {
  cue: Cue;
  /** The panel is open on Computer. */
  pressed: boolean;
  /** False while the thread's row is too narrow to draw the panel. */
  room?: boolean;
  onClick: () => void;
}) {
  // Its hook hands one object per change, so the compiler's caches would
  // only cost first-paint bytes here.
  "use no memo";
  const noRoom = room === false;
  return (
    // The fade rides a wrapper (`FADE_IN`), so the button keeps its hover fill on `--dur-hover`.
    <span className={`inline-flex ${FADE_IN}`}>
      <Tip label={noRoom ? NO_ROOM_LABEL : cue.line} side="bottom">
        <Button
          variant="ghost"
          size="xs"
          data-tauri-drag-region="false"
          data-computer-cue
          data-state={cue.state}
          aria-label={cue.line}
          aria-pressed={!noRoom && pressed}
          aria-disabled={noRoom || undefined}
          onClick={noRoom ? undefined : onClick}
          className={CUE}
          // The section's chunk is a hover away from its first use.
          {...computerChunk.intent}
        >
          <StatusMark state={cue.state} word={false} still aria-hidden />
          <MorphText state={cue.label} className={cue.state === "waiting" ? "font-medium text-warning" : undefined}>
            {cue.label}
          </MorphText>
        </Button>
      </Tip>
    </span>
  );
}

/** The quiet row control (`ROW_CONTROL`: 12px muted, the /5 hover fill) at
 *  24px, its glyph 8px from its words, pressed like the panel toggle and the
 *  agents cue beside it. */
const CUE = `${ROW_CONTROL} gap-2 aria-pressed:bg-muted aria-pressed:text-foreground aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground`;

/** The cue for one tab: the computer sessions of the thread its pane shows
 *  (a master's open child, else the tab's own); nothing while none is live. */
export function ComputerCue({ threadId, room }: { threadId: string | null; room?: boolean }) {
  const shownId = useShownThreadId(threadId);
  const cue = useComputerCue(shownId);
  const panel = useRightPanel(threadId ?? "");
  const shown = useShownSection(threadId ?? "");
  if (!cue || !threadId) return null;
  // The section the open panel draws, by name or by default; what was asked for until it reports.
  const pressed = panel.open && (shown ?? panel.section) === "computer";
  return <ComputerCueView cue={cue} pressed={pressed} room={room} onClick={() => (pressed ? rightPanel.close(threadId) : rightPanel.open(threadId, "computer"))} />;
}
