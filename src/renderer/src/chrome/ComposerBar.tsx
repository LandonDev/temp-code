import { useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/lazy-menus";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { composerActionHint, composerActionLabel, type ComposerIntent } from "../lib/composerAction";
import { MOD } from "../lib/platform";
import { SwapIcon } from "../motion/IconSwap";
import { sessionStore } from "../lib/tcserver/store";
import type { HarnessId, RuntimeMode } from "../lib/session";
import { AccessPicker } from "./AccessPicker";
import { ArrowUp, AtSign, CornerDownRight, ListPlus, Paperclip, Pause, Plus, Slash } from "./icons";

/**
 * The quiet row under the composer's box, 4px below it and 24px tall
 * (docs/DESIGN.md "The transcript"): the model button on the left, the
 * context meter (an existing thread with a reading) and the permission mode
 * (absent for fx, which has none) on the right, ghost controls in 12px muted
 * text. It is always there, so nothing moves on focus; its edges are the
 * box's. It is the `composer-bar` size container, so a narrow box gives way
 * in order: the free space, then the meter's percent (under 25rem, down to
 * its ring), then the model's effort word (under 23rem), then the mode's
 * label (under 20rem, down to its icon), then the model's name (under 9rem,
 * down to its harness icon). Every control fits a 220px box. The `+` menu
 * and Send sit in the box, on the field's bottom line. The Composer's one
 * TooltipProvider spans the box and this row.
 */
export function ComposerBar({
  harness,
  model,
  runtimeMode,
  onRuntimeModeChange,
  onClose,
  context,
}: {
  harness: HarnessId;
  /** The model button and its menu. */
  model: ReactNode;
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onClose: () => void;
  /** The context meter, before the permission mode. */
  context?: ReactNode;
}) {
  return (
    <div data-composer-bar className="@container/composer-bar mt-1 flex h-6 min-w-0 items-center gap-1 px-1.5">
      {model}
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {context}
        {harness !== "fx" ? <AccessPicker quiet value={runtimeMode} onChange={onRuntimeModeChange} onClose={onClose} /> : null}
      </div>
    </div>
  );
}

/** The box's `+` (28px, at the field's bottom-left): attach, mention and the
 *  skills list, the three ways to add to a message. */
export function AddMenu({
  attachable,
  onAttach,
  onInsert,
  fieldOf,
}: {
  attachable: boolean;
  onAttach: () => void;
  onInsert: (mark: "@" | "/") => void;
  fieldOf: () => HTMLElement | null;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="Add" className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground" />}
            />
          }
        >
          <Plus className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Add</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" finalFocus={() => fieldOf()} data-add-menu className="w-56" aria-label="Add">
        <DropdownMenuItem disabled={!attachable} onClick={onAttach}>
          <Paperclip />
          Attach files
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onInsert("@")}>
          <AtSign />
          Mention a file or thread
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onInsert("/")}>
          <Slash />
          Skills and commands
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The composer's surface: the box's fill and hairline, shared by the
 *  checkpoint strip that sits on its top edge (chrome/SessionReview.tsx). */
export const COMPOSER_SURFACE = "border border-border bg-card";

/** Whether the draft's controls under the box (project, host, type) show: on
 *  the shell's new-thread screen and on a thread with no message yet. After
 *  the first message the branch stays there alone; the type is the thread
 *  menu's Type submenu. */
export function useDraftRow(sessionId: string | undefined, shell = false): boolean {
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => shell || !sessionId || (sessionStore.get(sessionId)?.blocks.length ?? 0) === 0,
  );
}

const GLYPH = { send: ArrowUp, queue: ListPlus, steer: CornerDownRight, pause: Pause } as const;

/**
 * The composer's one primary: its glyph is what Enter would do (send,
 * queue, steer, or pause when the box is empty mid-turn), swapping through
 * `SwapIcon` on a change; disabled and enabled ease their opacity. Its
 * tooltip names the intent and, mid-turn, the other key.
 */
export function SendButton({
  intent,
  disabled,
  onSubmit,
  onPause,
}: {
  intent: ComposerIntent;
  disabled: boolean;
  /** Send, queue or steer with what is in the box; `invert` is ⌘click. */
  onSubmit: (invert: boolean) => void;
  onPause: () => void;
}) {
  // SwapIcon swaps two sides; flipping the side on every change of intent
  // keys each glyph apart, so four intents swap the same way two would.
  const [side, setSide] = useState({ intent, swapped: false });
  if (side.intent !== intent) setSide({ intent, swapped: !side.swapped });
  const label = composerActionLabel(intent);
  const hint = composerActionHint(intent, MOD);
  const Glyph = GLYPH[intent];
  const glyph = <Glyph className="size-4" />;
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (intent === "pause") onPause();
    else onSubmit(e.metaKey);
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            rounded
            aria-label={label}
            data-intent={intent}
            disabled={disabled}
            onClick={onClick}
            className="transition-[opacity,color] duration-(--dur-fast)"
          />
        }
      >
        {/* The clip for the swap sits inside, so the raise's shadow is not clipped. */}
        <span className="flex size-full items-center justify-center overflow-hidden rounded-[inherit]">
          <SwapIcon swapped={side.swapped} from={glyph} to={glyph} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <span>{label}</span>
        {hint ? (
          <span className="flex items-center gap-1 font-normal text-background/60">
            <Kbd>{hint.keys}</Kbd>
            {hint.verb}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
