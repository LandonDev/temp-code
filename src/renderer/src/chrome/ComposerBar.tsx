import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { MouseEvent } from "react";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { composerActionHint, composerActionLabel, type ComposerIntent } from "../lib/composerAction";
import { DUR, EASE_OUT } from "../lib/ease";
import { MOD } from "../lib/platform";
import { ArrowUp, CornerDownRight, ListPlus, Pause } from "./icons";

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
