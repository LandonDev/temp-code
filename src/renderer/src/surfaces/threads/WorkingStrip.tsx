import { memo, useEffect, useMemo, useState } from "react";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { Pause } from "../../chrome/icons";
import type { Session } from "../../lib/session";
import { MatrixSpinner, duration } from "./bits";

/**
 * The working indicator, in a permanently reserved 28px strip above the
 * composer — the composer never shifts when work starts or stops.
 * `Sending…` bridges send → turn-start; then the matrix spinner, a
 * rotating flavour word, and elapsed `1m 32s`. A paused run fills the
 * slot with one warning-tinted row at composer width: the glyph, Paused,
 * the frozen elapsed, and Stop / Continue on the right. Only opacity
 * animates in and out (120ms); the slot never changes height.
 */

const FLAVOUR_WORDS = [
  "Thinking",
  "Pondering",
  "Scheming",
  "Brewing",
  "Weaving",
  "Tinkering",
  "Musing",
  "Composing",
  "Sifting",
  "Untangling",
  "Distilling",
  "Sketching",
  "Plotting",
  "Riffing",
  "Combobulating",
  "Percolating",
  "Marinating",
  "Noodling",
  "Puzzling",
  "Conjuring",
] as const;

const seedOf = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** When the current working stretch began: server-stamped, else the last user turn. */
export function turnStartOf(session: Session): number | undefined {
  if (session.busySince) return session.busySince;
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const b = session.blocks[i];
    if (b.role === "user") return b.ts ?? b.startedAt;
  }
  return undefined;
}

export const WorkingStrip = memo(function WorkingStrip({
  session,
  onStop,
  onResume,
}: {
  session: Session;
  onStop: () => void;
  onResume: () => Promise<void> | void;
}) {
  const status = session.status ?? (session.busy ? "running" : "idle");
  const running = status === "running" || (status !== "starting" && status !== "paused" && !!session.busy);
  const starting = status === "starting";
  const paused = status === "paused";
  const active = running || starting;
  const visible = active || paused;
  const turnStart = turnStartOf(session);

  const shown = usePaneVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !shown) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, shown]);
  const elapsed = paused
    ? Math.max(0, session.frozenActiveElapsed ?? 0)
    : active
      ? Math.max(0, now - (turnStart ?? now))
      : 0;

  const seed = useMemo(() => seedOf(session.id), [session.id]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running || !shown) return;
    const t = setInterval(() => setTick((n) => n + 1), 7000);
    return () => clearInterval(t);
  }, [running, shown]);
  const word = FLAVOUR_WORDS[(seed + tick) % FLAVOUR_WORDS.length];
  const [resumeBusy, setResumeBusy] = useState(false);
  const resume = (): void => {
    if (resumeBusy) return;
    setResumeBusy(true);
    Promise.resolve(onResume()).finally(() => setResumeBusy(false));
  };

  return (
    <div className="mx-auto h-7 w-full max-w-4xl shrink-0">
      <div
        className={`flex h-full items-center gap-2 transition-opacity duration-[120ms] ease-[var(--ease-out)] ${
          visible ? "opacity-100" : "opacity-0"
        } ${
          paused
            ? "rounded-lg border border-warning/20 bg-warning/10 px-3"
            : "px-4 text-xs text-content/50"
        }`}
        aria-live="polite"
      >
        {paused ? (
          <>
            <Pause className="size-3.5 shrink-0 text-warning" strokeWidth={1.75} />
            <span className="text-[12px] font-medium text-content">Paused</span>
            <span className="text-[11px] tabular-nums text-content/50">{duration(elapsed)}</span>
            <button
              type="button"
              onClick={onStop}
              className="pressable ml-auto h-6 rounded-md px-2 text-[11px] text-content/60 hover:bg-content/8 hover:text-danger"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={resume}
              disabled={resumeBusy}
              className="pressable h-6 rounded-md bg-warning px-2.5 text-[11px] font-medium text-background-base disabled:cursor-default disabled:opacity-60"
            >
              {resumeBusy ? "Continuing…" : "Continue"}
            </button>
          </>
        ) : starting ? (
          <span>Sending…</span>
        ) : (
          <>
            <MatrixSpinner tint={session.activityKind} />
            <span>{word}</span>
            <span className="tabular-nums text-content/40">{duration(elapsed)}</span>
          </>
        )}
      </div>
    </div>
  );
});
