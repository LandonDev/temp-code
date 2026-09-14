import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { basename } from "../lib/fs";
import { looksLikeProject } from "../lib/recents";
import {
  loadGridArcadeEnabled,
  subscribeGridArcadeEnabled,
} from "../lib/settings";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import type { ThreadType } from "../lib/tcserver/types";
import { TerminalGridBackground } from "./TerminalGridBackground";
import {
  THREAD_GLYPHS,
  THREAD_HINTS,
  THREAD_LABELS,
  THREAD_TINTS,
  THREAD_TYPES,
} from "./threads/bits";

type Props = {
  cwd: string;
  /** The arcade runs only in the focused pane of the shown tab. */
  arcade?: boolean;
  composer?: ReactNode;
  threadType?: ThreadType;
  onThreadTypeChange?: (type: ThreadType) => void;
};

/** The five thread types, picked before the first message. */
function TypePicker({
  value,
  onChange,
}: {
  value: ThreadType;
  onChange: (type: ThreadType) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Thread type" className="mb-3 flex flex-wrap gap-1 px-1">
      {THREAD_TYPES.map((type) => {
        const Icon = THREAD_GLYPHS[type];
        const selected = type === value;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            title={THREAD_HINTS[type]}
            onClick={() => onChange(type)}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors ${
              selected
                ? "bg-content/10 text-content"
                : "text-content/55 hover:bg-content/5 hover:text-content/85"
            }`}
          >
            <Icon className={`size-3.5 ${selected ? THREAD_TINTS[type] : ""}`} strokeWidth={1.75} />
            {THREAD_LABELS[type]}
          </button>
        );
      })}
    </div>
  );
}

export function EmptySession({ cwd, arcade = true, composer, threadType, onThreadTypeChange }: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  // The canvas mounts a frame after the pane painted, never on the same
  // commit as the tab switch.
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if (!arcade) return;
    const id = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(id);
  }, [arcade]);
  const arcadeEnabled = useSyncExternalStore(
    subscribeGridArcadeEnabled,
    loadGridArcadeEnabled,
    () => true,
  );
  const project = looksLikeProject(cwd) ? basename(cwd) : null;
  const title = project
    ? `What should we work on in ${project}?`
    : "What should we work on?";

  return (
    <div
      ref={lockOverscroll}
      className="relative flex h-full min-h-0 overflow-y-auto overscroll-none"
    >
      {arcadeEnabled && arcade && painted ? <TerminalGridBackground /> : null}
      {composer ? (
        <div className="pointer-events-none relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-12">
          <div className="pointer-events-auto mb-4 px-2.5">
            <h1
              className="truncate text-lg text-content"
              title={project ? cwd : undefined}
            >
              {title}
            </h1>
          </div>

          {onThreadTypeChange ? (
            <div className="pointer-events-auto">
              <TypePicker value={threadType ?? "chat"} onChange={onThreadTypeChange} />
            </div>
          ) : null}
          <div className="pointer-events-auto w-full">{composer}</div>
        </div>
      ) : null}
    </div>
  );
}
