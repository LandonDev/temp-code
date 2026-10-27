import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { X } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { DUR, EASE_OUT, FADE_OUT, SPRING_PANEL } from "../../../lib/ease";
import type { OpenFileFn } from "../../../lib/search";
import { useMetaById } from "../../../lib/threads/agents";
import { AgentDetailBody } from "./AgentDetailBody";

/**
 * A subagent in a pane-scoped overlay: the container for its content
 * (AgentDetailBody: header, transcript, steer field), with the close button.
 *
 * The panel is a sheet at the pane's right edge: it slides in from off the
 * right on the panel spring (no bounce) at its final width from the first
 * frame, and slides back out over 160ms; under reduced motion it fades.
 * The transcript is a heavy, live-streaming subtree: mounted inside the
 * moving element it re-layouts on every chunk and wrecks the spring, so
 * it mounts once the slide settles and unmounts before the close.
 */
export function AgentDetail({
  agentId,
  parentCwd,
  onClose,
  onOpenSession,
  onOpenFile,
  onOpenDiff,
}: {
  agentId: string;
  parentCwd: string;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path?: string) => void;
}) {
  const meta = useMetaById(agentId);
  const reduce = useReducedMotion();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    // onAnimationComplete can miss (an interrupted slide); never leave the
    // body empty past the slide's length.
    const t = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(t);
  }, []);

  const motionProps = useMemo(
    () =>
      reduce
        ? {
            initial: { opacity: 0 },
            animate: { opacity: 1 },
            exit: { opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } },
          }
        : {
            initial: { x: "100%" },
            animate: { x: 0 },
            exit: { x: "100%", transition: { duration: 0.16, ease: EASE_OUT } },
          },
    [reduce],
  );

  const close = () => {
    setSettled(false);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSettled(false);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!meta) return null;

  return (
    <div className="absolute inset-0 z-40 flex justify-end overflow-hidden">
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={FADE_OUT}
        transition={{ duration: DUR.fast, ease: EASE_OUT }}
        className="absolute inset-0 bg-black/40 glass-surface glass-surface--md"
        onClick={close}
      />
      <motion.div
        {...motionProps}
        transition={SPRING_PANEL}
        onAnimationComplete={(definition) => {
          if (definition === motionProps.animate) setSettled(true);
        }}
        className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-content/10 shadow-2xl glass-surface floating-surface"
      >
        <AgentDetailBody
          agentId={agentId}
          parentCwd={parentCwd}
          ready={settled}
          onOpenSession={onOpenSession}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onClose={close}
        />
        <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close" className="absolute top-3.5 right-3">
          <X />
        </Button>
      </motion.div>
    </div>
  );
}
