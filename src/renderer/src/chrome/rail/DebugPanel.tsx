import { useEffect, useRef, useState } from "react";
import { useEditorState } from "../../lib/monaco/editorState";
import { openFileAt } from "../../lib/monaco/opener";
import { cn } from "../../motion/cn";
import { debugController } from "../../surfaces/monaco/debug/session";
import { ArrowDownLong, ArrowTurnForward, ArrowUpLong, Play, Square, type IconComponent } from "../icons";

/**
 * The Debug tab: the one DAP session the editor chunk owns (⌃D or
 * "Debug this file" in a Java buffer starts it), shown as controls, the
 * call stack, the variables tree (expand in place), the console, and an
 * evaluate line. Loaded lazily by the rail — this module reaches into the
 * Monaco chunk for the controller.
 */
export default function DebugPanel() {
  const phase = useEditorState((s) => s.debugPhase);
  const frames = useEditorState((s) => s.debugFrames);
  const variables = useEditorState((s) => s.debugVariables);
  const output = useEditorState((s) => s.debugOutput);
  const error = useEditorState((s) => s.debugError);
  const [expr, setExpr] = useState("");
  // The frame whose variables are shown; the top frame until one is picked.
  const [frameId, setFrameId] = useState<number | null>(null);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [output]);

  const stopped = phase === "stopped";
  const activeFrame = frameId ?? frames[0]?.id;

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-content/10 px-2">
        {phase === "idle" ? (
          <span className="px-1 text-[12px] text-content/50">⌃D in a Java file starts it here</span>
        ) : (
          <>
            <Control label="Continue" icon={Play} enabled={stopped} onClick={() => debugController()?.step("continue")} />
            <Control label="Step over" icon={ArrowTurnForward} enabled={stopped} onClick={() => debugController()?.step("next")} />
            <Control label="Step into" icon={ArrowDownLong} enabled={stopped} onClick={() => debugController()?.step("stepIn")} />
            <Control label="Step out" icon={ArrowUpLong} enabled={stopped} onClick={() => debugController()?.step("stepOut")} />
            <span className="flex-1" />
            <span className="text-[11px] tabular-nums text-content/50">{phase}</span>
            <Control label="Stop" icon={Square} enabled onClick={() => debugController()?.stop()} />
          </>
        )}
      </div>
      {error ? (
        <p className="break-words border-b border-content/10 px-2 py-2 text-[11px] leading-snug text-danger">{error}</p>
      ) : null}
      {frames.length > 0 ? (
        <div className="max-h-40 shrink-0 overflow-y-auto border-b border-content/10 px-2 py-1">
          {frames.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFrameId(f.id);
                if (f.path) openFileAt(f.path, f.line, 1);
                void debugController()?.loadVariables(f.id);
              }}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left",
                f.id === activeFrame ? "bg-content/10 text-content" : "hover:bg-content/5 active:bg-content/10",
              )}
            >
              <span className={cn("min-w-0 flex-1 truncate text-[12px]", !f.path && "text-content/40")}>{f.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-content/40">{f.line}</span>
            </button>
          ))}
        </div>
      ) : null}
      {variables.length > 0 ? (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-content/10 px-2 py-1 font-mono text-[11px]">
          {variables.map((v, i) => (
            <button
              key={`${v.name}:${i}`}
              type="button"
              onClick={() => {
                if (v.ref) void debugController()?.loadVariables(v.frameId, v.ref, v.depth + 1);
              }}
              className="flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-content/5 active:bg-content/10"
              style={{ paddingLeft: 8 + v.depth * 12 }}
            >
              <span className="shrink-0 text-info">{v.name}</span>
              <span className="truncate text-content/50">{v.value}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div
        ref={outRef}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2 font-mono text-[11px] leading-relaxed text-content/70"
      >
        {output.map((line, i) => (
          <div key={i} className="break-all whitespace-pre-wrap">
            {line}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const q = expr.trim();
          if (!q) return;
          setExpr("");
          void debugController()?.evaluate(q);
        }}
        className="border-t border-content/10"
      >
        <input
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder={stopped ? "Evaluate…" : ""}
          disabled={!stopped}
          aria-label="Evaluate expression"
          className="w-full bg-transparent px-2 py-2 font-mono text-[12px] text-content outline-none placeholder:text-content/40 disabled:opacity-40"
        />
      </form>
    </div>
  );
}

function Control({
  label,
  icon: Icon,
  enabled,
  onClick,
}: {
  label: string;
  icon: IconComponent;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={!enabled}
      onClick={onClick}
      className="pressable grid size-6 place-items-center rounded-md text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}
