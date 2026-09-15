import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { MouseEvent } from "react";
import { EASE_OUT } from "../lib/ease";
import {
  composerActionHint,
  composerActionLabel,
  type ComposerIntent,
} from "../lib/composerAction";
import { MOD } from "../lib/platform";
import type { MidTurnDefault } from "../lib/settings";
import { ArrowUp, ListPlus, Pause } from "./icons";

type Props = {
  intent: ComposerIntent;
  midTurnDefault: MidTurnDefault;
  disabled: boolean;
  /** Send, queue or steer with what is in the box; `invert` is ⌘click. */
  onSubmit: (invert: boolean) => void;
  onPause: () => void;
};

/**
 * The composer's one button. Its glyph morphs with what Enter would do:
 * ↑ send, a list-plus while a turn runs (queue or steer), ‖ pause when the
 * box is empty mid-turn. Stop lives elsewhere (WorkingStrip, chip menu,
 * banner) so this stays a single target.
 */
export function ComposerAction({ intent, midTurnDefault, disabled, onSubmit, onPause }: Props) {
  const reduce = useReducedMotion();
  const label = composerActionLabel(intent);
  const glyph = intent === "pause" ? "pause" : intent === "send" ? "send" : "queue";
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (intent === "pause") onPause();
    else onSubmit(e.metaKey);
  };
  return (
    <button
      type="button"
      title={composerActionHint(intent, midTurnDefault, MOD) ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="pressable relative grid size-6.5 place-items-center overflow-hidden rounded-md bg-white text-black hover:bg-white/90 disabled:cursor-default disabled:bg-white/30 disabled:text-black/40 disabled:hover:bg-white/30"
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={glyph}
          initial={reduce ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.1, ease: EASE_OUT }}
          className="absolute inset-0 grid place-items-center"
        >
          {glyph === "pause" ? (
            <Pause className="size-3.5 fill-warning text-warning" strokeWidth={0} />
          ) : glyph === "queue" ? (
            <ListPlus className="size-3.5" strokeWidth={2} />
          ) : (
            <ArrowUp className="size-3.5" strokeWidth={2.25} />
          )}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
