import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
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
import { DUR, EASE_OUT } from "../lib/ease";
import { MOD } from "../lib/platform";
import { sessionStore } from "../lib/tcserver/store";
import { harnessSupportsAttachments, type HarnessId, type RuntimeMode } from "../lib/session";
import { AccessPicker } from "./AccessPicker";
import { ArrowUp, AtSign, CornerDownRight, ListPlus, Paperclip, Pause, Plus, Slash } from "./icons";

/**
 * The composer's one row under the field, 32px tall and never scrolling:
 * the `+` menu and the model button on the left, the permission mode
 * (absent for fx, which has none) and the send button on the right. It is
 * the `composer-bar` size container, so a narrow box gives way in order:
 * the free space, then the model's effort word and name (down to its
 * harness icon), then the mode's label (down to its icon). Add and Send
 * never shrink; every control fits a 220px box.
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
  send: ReactNode;
}) {
  return (
    <TooltipProvider>
      <div data-composer-bar className="@container/composer-bar mx-2 mb-2 flex h-8 min-w-0 items-center gap-1">
        <AddMenu attachable={harnessSupportsAttachments(harness)} onAttach={onAttach} onInsert={onInsert} fieldOf={fieldOf} />
        {model}
        <div className="ms-auto flex shrink-0 items-center gap-1">
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
 * queue, steer, or pause when the box is empty mid-turn), cross-fading on
 * a change. Its tooltip names the intent and, mid-turn, the other key.
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
  const reduce = useReducedMotion();
  const label = composerActionLabel(intent);
  const hint = composerActionHint(intent, MOD);
  const Glyph = GLYPH[intent];
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
            className="overflow-hidden"
          />
        }
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={intent}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
            transition={{ duration: DUR.fast, ease: EASE_OUT }}
            className="grid place-items-center"
          >
            <Glyph className="size-4" strokeWidth={intent === "pause" ? 1.75 : 2} />
          </motion.span>
        </AnimatePresence>
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
