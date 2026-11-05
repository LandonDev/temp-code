import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { FADE_IN } from "../components/ui/reveal";
import { StatusMark } from "../components/ui/status";
import { MorphText } from "../motion/MorphText";
import { NO_ROOM_LABEL, rightPanel, useRightPanel, useShownSection, useShownThreadId } from "../lib/rightPanel";
import { useAgentsCue, type AgentsCue as Cue } from "../lib/threads/agents";
import { ROW_CONTROL } from "./composerRow";
import { HarnessIcon } from "./HarnessIcon";

/**
 * The title bar's live-agents cue (docs/LAYOUT.md "Titlebar"): while a
 * subagent of the thread on screen works, waits or is queued, a quiet 24px
 * control left of ⋯: the state's glyph, one 12px mark per provider the live
 * agents run on (at most four, then "+N"), and the count's words, "3
 * agents", or "1 needs you" in amber while one waits on the person. It opens
 * the right panel on Agents and, pressed, closes it again. The glyph spins
 * only while the thread itself is not running a turn (its tab and working
 * line already spin then, so the cue draws working's still dot). It fades in
 * on `--dur-fast` and leaves at once, so no dead control stays under the
 * pointer; once there, a new count morphs its words and a provider's mark
 * grows in or leaves in place, so the control never remounts.
 */
export function AgentsCueView({
  cue,
  pressed,
  room,
  onClick,
}: {
  cue: Cue;
  /** The panel is open on Agents. */
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
          data-agents-cue
          data-state={cue.state}
          aria-label={cue.line}
          aria-pressed={!noRoom && pressed}
          aria-disabled={noRoom || undefined}
          onClick={noRoom ? undefined : onClick}
          className={CUE}
        >
          <StatusMark state={cue.state} word={false} still={cue.still} aria-hidden />
          {cue.marks.length ? (
            <span data-slot="cue-marks" aria-hidden className="flex items-center gap-0.5">
              {cue.marks.map((mark) => (
                <span key={mark} data-mark={mark} className={MARK}>
                  <HarnessIcon harness={mark} className="size-3" />
                </span>
              ))}
              {cue.more ? <span className="tabular-nums">+{cue.more}</span> : null}
            </span>
          ) : null}
          <MorphText state={cue.label} className={cue.state === "waiting" ? "font-medium text-warning tabular-nums" : "tabular-nums"}>
            {cue.label}
          </MorphText>
        </Button>
      </Tip>
    </span>
  );
}

/** The quiet row control (`ROW_CONTROL`: 12px muted, the /5 hover fill) at
 *  24px, pressed like the panel toggle beside it. */
const CUE = `${ROW_CONTROL} gap-1.5 aria-pressed:bg-muted aria-pressed:text-foreground aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground`;

/** A provider's mark, 2px from the next: one that joins grows in from a
 *  quarter on the layout spring's curve (`@starting-style`, so the first
 *  marks grow inside the cue's own fade); one that leaves goes at once, as
 *  the cue does. Reduced motion fades. */
const MARK = "transition-[opacity,scale] duration-(--dur-layout) ease-(--ease-layout) starting:scale-25 starting:opacity-0 motion-reduce:transition-opacity";

/** The cue for one tab: the subagents of the thread its pane shows (a
 *  master's open child, else the tab's own); nothing while none is live. */
export function AgentsCue({ threadId, room }: { threadId: string | null; room?: boolean }) {
  const shownId = useShownThreadId(threadId);
  const cue = useAgentsCue(shownId, shownId !== threadId);
  const panel = useRightPanel(threadId ?? "");
  const shown = useShownSection(threadId ?? "");
  if (!cue || !threadId) return null;
  // The section the open panel draws, by name or by default; what was asked for until it reports.
  const pressed = panel.open && (shown ?? panel.section) === "agents";
  return (
    <AgentsCueView
      cue={cue}
      pressed={pressed}
      room={room}
      onClick={() => (pressed ? rightPanel.close(threadId) : rightPanel.open(threadId, "agents"))}
    />
  );
}
