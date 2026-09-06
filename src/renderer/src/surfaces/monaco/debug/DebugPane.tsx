import { useEffect, useRef, useState } from "react";
import { basename } from "../../../lib/fs";
import { useEditorState } from "../../../lib/monaco/editorState";
import type { OpenFileFn } from "../../../lib/search";
import { debugController } from "./session";

/**
 * The debugger pane, docked below the editor: one controls row, the call
 * stack, the variables tree (expand in place), and the console with an
 * evaluate input.
 */
export default function DebugPane({ path, onOpenFile }: { path: string; onOpenFile?: OpenFileFn }) {
  const phase = useEditorState((s) => s.debugPhase);
  const frames = useEditorState((s) => s.debugFrames);
  const variables = useEditorState((s) => s.debugVariables);
  const output = useEditorState((s) => s.debugOutput);
  const error = useEditorState((s) => s.debugError);
  const [expr, setExpr] = useState("");
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [output]);

  const stopped = phase === "stopped";

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-content/10 px-2">
        <Control label="Continue" glyph="▶" enabled={stopped} onClick={() => debugController()?.step("continue")} />
        <Control label="Step over" glyph="⤵" enabled={stopped} onClick={() => debugController()?.step("next")} />
        <Control label="Step into" glyph="↓" enabled={stopped} onClick={() => debugController()?.step("stepIn")} />
        <Control label="Step out" glyph="↑" enabled={stopped} onClick={() => debugController()?.step("stepOut")} />
        <span className="ml-2 min-w-0 flex-1 truncate text-content/45">
          {basename(path)}
          <span className="ml-2 tabular-nums text-content/35">{phase === "idle" ? "" : phase}</span>
        </span>
        <Control label="Stop" glyph="■" enabled={phase !== "idle"} onClick={() => debugController()?.stop()} />
      </div>
      {error ? <p className="border-b border-content/10 px-3 py-1.5 text-danger">{error}</p> : null}
      {frames.length > 0 ? (
        <div className="max-h-40 shrink-0 overflow-y-auto border-b border-content/10 py-1">
          {frames.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                if (f.path) onOpenFile?.(f.path, { line: f.line, column: 1 });
                void debugController()?.loadVariables(f.id);
              }}
              className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-content/5"
            >
              <span className={`truncate ${f.path ? "" : "text-content/45"}`}>{f.name}</span>
              <span className="ml-auto shrink-0 tabular-nums text-content/40">{f.line}</span>
            </button>
          ))}
        </div>
      ) : null}
      {variables.length > 0 ? (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-content/10 py-1 font-mono text-[11px]">
          {variables.map((v, i) => (
            <button
              key={`${v.name}:${i}`}
              type="button"
              onClick={() => {
                if (v.ref) void debugController()?.loadVariables(v.frameId, v.ref, v.depth + 1);
              }}
              className="flex w-full gap-1.5 py-0.5 pr-3 text-left hover:bg-content/5"
              style={{ paddingLeft: `${12 + v.depth * 12}px` }}
            >
              <span className="shrink-0 text-info">{v.name}</span>
              <span className="truncate text-content/60">{v.value}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div ref={outRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-content/70">
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
          className="w-full bg-transparent px-3 py-1.5 font-mono text-[11.5px] text-content outline-none placeholder:text-content/35 disabled:opacity-40"
        />
      </form>
    </div>
  );
}

function Control({ label, glyph, enabled, onClick }: { label: string; glyph: string; enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={!enabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-[12px] text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {glyph}
    </button>
  );
}
