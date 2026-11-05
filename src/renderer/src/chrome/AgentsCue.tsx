import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { StatusMark } from "../components/ui/status";
import { NO_ROOM_LABEL, rightPanel, useRightPanel } from "../lib/rightPanel";
import { useAgentsCue, type AgentsCue as Cue } from "../lib/threads/agents";

/**
 * The title bar's live-agents cue (docs/LAYOUT.md "Titlebar"): while a
 * subagent of the thread on screen works, waits or is queued, a quiet chip
 * left of ⋯ with the state's glyph and "3 agents". It opens the right
 * panel on Agents and, pressed, closes it again. The glyph spins only while
 * the thread itself is not running a turn (its tab and working line already
 * spin then, so the cue draws working's still dot), and waiting's amber
 * leads. It fades in on `--dur-fast` and leaves at once, so no dead control
 * stays under the pointer.
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
  const noRoom = room === false;
  return (
    <Tip label={noRoom ? NO_ROOM_LABEL : cue.line} side="bottom">
      <Button
        variant="ghost"
        size="sm"
        data-tauri-drag-region="false"
        data-agents-cue
        data-state={cue.state}
        aria-label={cue.line}
        aria-pressed={!noRoom && pressed}
        aria-disabled={noRoom || undefined}
        onClick={noRoom ? undefined : onClick}
        className="gap-1.5 font-normal text-muted-foreground transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 hover:text-foreground aria-pressed:bg-foreground/7 aria-pressed:text-foreground aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground motion-reduce:transition-opacity"
      >
        <StatusMark state={cue.state} word={false} still={cue.still} aria-hidden />
        <span className="tabular-nums">{cue.label}</span>
      </Button>
    </Tip>
  );
}

/** The cue for one thread: nothing while none of its subagents is live. */
export function AgentsCue({ threadId, room }: { threadId: string | null; room?: boolean }) {
  const cue = useAgentsCue(threadId);
  const panel = useRightPanel(threadId ?? "");
  if (!cue || !threadId) return null;
  const pressed = panel.open && panel.section === "agents";
  return (
    <AgentsCueView
      cue={cue}
      pressed={pressed}
      room={room}
      onClick={() => (pressed ? rightPanel.close(threadId) : rightPanel.open(threadId, "agents"))}
    />
  );
}
