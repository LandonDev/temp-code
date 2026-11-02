import { useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { composerActionHint, composerActionLabel, type ComposerIntent } from "../lib/composerAction";
import { MOD } from "../lib/platform";
import { SwapIcon } from "../motion/IconSwap";
import { sessionStore } from "../lib/tcserver/store";
import { harnessSupportsAttachments, type HarnessId, type RuntimeMode } from "../lib/session";
import { AccessPicker } from "./AccessPicker";
import { ArrowUp, AtSign, CornerDownRight, ListPlus, Paperclip, Pause, Plus, Slash } from "./icons";

/**
 * The composer's one row under the field, 28px tall, 6px in from the box's
 * sides and bottom (its 12px radius less 6 is the controls' 6px), never
 * scrolling:
 * the `+` menu and the model button on the left, the context meter (an
 * existing thread with a reading), the permission mode (absent for fx,
 * which has none) and the send button on the right. It is the
 * `composer-bar` size container, so a narrow box gives way in order: the
 * free space, then the meter's percent (down to its ring), then the model's
 * effort word and name (down to its harness icon), then the mode's label
 * (down to its icon). Add and Send never shrink; every control fits a 220px
 * box.
 */
export function ComposerBar({
  harness,
  model,
  runtimeMode,
  onRuntimeModeChange,
  onAttach,
  onInsert,
  fieldOf,
  onClose,
  context,
  send,
}: {
  harness: HarnessId;
  /** The model button and its menu. */
  model: ReactNode;
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onAttach: () => void;
  /** Types `@` or `/` at the caret, which opens that list. */
  onInsert: (mark: "@" | "/") => void;
  /** The field, where a closing menu returns the focus. */
  fieldOf: () => HTMLElement | null;
  onClose: () => void;
  /** The context meter, before the permission mode. */
  context?: ReactNode;
  send: ReactNode;
}) {
  return (
    <TooltipProvider>
      <div data-composer-bar className="@container/composer-bar mx-1.5 mb-1.5 flex h-7 min-w-0 items-center gap-1">
        <AddMenu attachable={harnessSupportsAttachments(harness)} onAttach={onAttach} onInsert={onInsert} fieldOf={fieldOf} />
        {model}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {context}
          {harness !== "fx" ? <AccessPicker value={runtimeMode} onChange={onRuntimeModeChange} onClose={onClose} /> : null}
          {send}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Attach, mention and the skills list: the three ways to add to a message. */
function AddMenu({
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
  const glyph = <Glyph className="size-4" strokeWidth={intent === "pause" ? 1.75 : 2} />;
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
            className="overflow-hidden transition-[opacity,background-color,color,border-color,scale]"
          />
        }
      >
        <SwapIcon swapped={side.swapped} from={glyph} to={glyph} />
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
