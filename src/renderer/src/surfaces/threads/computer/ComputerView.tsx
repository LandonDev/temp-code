import { forwardRef, type Ref } from "react";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { TruncateTip } from "@renderer/components/tip";
import { Square, SquareMousePointer } from "../../../chrome/icons";
import type { StepGroup } from "../../../lib/computerHistory";
import { StepList, type ReadFold, type RunningLine } from "./StepList";
import { Viewport, type ViewportProps } from "./Viewport";

/**
 * The right panel's Computer section, pure (docs/DESIGN.md "Panels",
 * docs/LAYOUT.md "The right side"): a column on the panel's 12px inset with
 * no card, border or header of its own. A row per live session (the window
 * in its app, Go live while a row is pinned, Stop), the viewport, then the
 * steps, which are the section's one scroller. One list is both the live
 * view and the history: the running call is its top line, the finished
 * steps sit under it, and choosing a row drives the picture. The container
 * (ComputerSection) joins the live rows, the journal and the stream; this
 * draws what it is given, so every state is a fixture.
 */

/** One live session of the thread's tree. */
export interface LiveSession {
  id: string;
  /** "Untitled in TextEdit" */
  label: string;
  stopping?: boolean;
}

export interface ComputerViewProps {
  /** the live sessions, the one that acted last (the one the viewport follows) first; it is drawn last, next to the box. None once the turn settled */
  sessions: readonly LiveSession[];
  /** a row was chosen by hand: Go live shows, and the viewport is that call's picture */
  pinned: boolean;
  /** null: nothing to show in a box and nothing to say under one */
  viewport: ViewportProps | null;
  running: readonly RunningLine[];
  groups: readonly StepGroup[];
  openId: string | null;
  /** the row that is open while the section follows: where Home and Go live put the focus */
  followId?: string | null;
  read: ReadFold;
  status: "loading" | "ready" | "failed";
  more: boolean;
  loadingMore?: boolean;
  onSelect: (id: string) => void;
  onFollow: () => void;
  onStop: (sessionId: string) => void;
  onToggleRead: () => void;
  onRetry: () => void;
  onOlder: () => void;
  /** the viewport's box (the stream writes its counts there) */
  boxRef?: Ref<HTMLElement>;
}

function SessionRow({ session, first, several, pinned, onFollow, onStop }: { session: LiveSession; first: boolean; several: boolean; pinned: boolean; onFollow: () => void; onStop: () => void }) {
  return (
    <div data-slot="computer-session" className="flex h-9 min-w-0 items-center gap-2">
      <SquareMousePointer className="size-3.5 shrink-0 text-muted-foreground" />
      <TruncateTip text={session.label}>
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground">{session.label}</span>
      </TruncateTip>
      {/* Neighbours share one provider: the second tooltip opens at once, its label moving instead of reopening. */}
      <TooltipProvider>
        {/* Go live belongs to the session the viewport follows, and only while a row is pinned. */}
        {first && pinned ? (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="xs" data-slot="go-live" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={onFollow} />}>Go live</TooltipTrigger>
            <TooltipContent>Follow the live window</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            // hung 8px out, so its 10px square ends on the viewport's edge under it
            // with several sessions each Stop says whose it is
            render={<Button variant="ghost" size="icon-xs" className="-me-2 shrink-0 text-muted-foreground hover:text-foreground" aria-label={several ? `Stop ${session.label}` : "Stop"} disabled={session.stopping} onClick={onStop} />}
          >
            <Square className="size-2.5 fill-current" />
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export const ComputerView = forwardRef(function ComputerView(props: ComputerViewProps, ref: Ref<HTMLDivElement>) {
  const { sessions, pinned, viewport, boxRef } = props;
  const head = sessions.length > 0 || viewport !== null;
  return (
    // A size container, so the viewport's cap can be a share of the section's height.
    <div ref={ref} data-slot="computer-section" data-following={!pinned || undefined} className="flex min-h-0 flex-1 flex-col [container-type:size]">
      {head ? (
        <div className={sessions.length ? "shrink-0 px-3 pt-1.5 pb-2" : "shrink-0 px-3 pt-3 pb-2"}>
          {/* The session the viewport follows is drawn last, right above the box, so the picture is never read as
              another session's; the others stand above it. */}
          {[...sessions].reverse().map((session) => (
            <SessionRow key={session.id} session={session} first={session === sessions[0]} several={sessions.length > 1} pinned={pinned} onFollow={props.onFollow} onStop={() => props.onStop(session.id)} />
          ))}
          {viewport ? <Viewport ref={boxRef} {...viewport} /> : null}
        </div>
      ) : (
        <div className="h-3 shrink-0" />
      )}
      <StepList
        running={props.running}
        groups={props.groups}
        openId={props.openId}
        followId={props.followId}
        pinned={pinned}
        read={props.read}
        status={props.status}
        more={props.more}
        loadingMore={props.loadingMore}
        onSelect={props.onSelect}
        onFollow={props.onFollow}
        onToggleRead={props.onToggleRead}
        onRetry={props.onRetry}
        onOlder={props.onOlder}
      />
    </div>
  );
});
