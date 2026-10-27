import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ItemButton, ItemActions, ItemContent } from "@renderer/components/ui/item";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { StatusMark } from "@renderer/components/ui/status";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { useEditorState, type DebugFrame, type DebugPhase, type DebugVariable } from "../../lib/monaco/editorState";
import { openFileAt } from "../../lib/monaco/opener";
import { debugController } from "../../surfaces/monaco/debug/session";
import { ArrowDownLong, ArrowTurnForward, ArrowUpLong, Play, Square, type IconComponent } from "../icons";

/** The four ways a paused session moves on (DAP request names). */
export type DebugStep = "continue" | "next" | "stepIn" | "stepOut";

/**
 * The right panel's Debug section: the one DAP session the editor chunk
 * owns (⌃D or "Debug this file" in a Java buffer starts it). Loaded
 * lazily by the panel; this module reaches into the Monaco chunk for the
 * controller. The container reads the editor state store and talks to the
 * controller; `DebugView` draws it from data and callbacks.
 */
export default function DebugPanel() {
  const phase = useEditorState((s) => s.debugPhase);
  const frames = useEditorState((s) => s.debugFrames);
  const variables = useEditorState((s) => s.debugVariables);
  const output = useEditorState((s) => s.debugOutput);
  const error = useEditorState((s) => s.debugError);
  // The frame whose variables are shown; the top frame until one is picked.
  const [frameId, setFrameId] = useState<number | null>(null);

  return (
    <DebugView
      phase={phase}
      frames={frames}
      variables={variables}
      output={output}
      error={error}
      activeFrameId={frameId ?? frames[0]?.id ?? null}
      onStep={(step) => debugController()?.step(step)}
      onStop={() => debugController()?.stop()}
      onSelectFrame={(f) => {
        setFrameId(f.id);
        if (f.path) openFileAt(f.path, f.line, 1);
        void debugController()?.loadVariables(f.id);
      }}
      onExpand={(v) => {
        if (v.ref) void debugController()?.loadVariables(v.frameId, v.ref, v.depth + 1);
      }}
      onEvaluate={(expr) => void debugController()?.evaluate(expr)}
    />
  );
}

/**
 * Idle: one muted line. While a session runs: the step controls, its
 * status and Stop; then the call stack, the variables and the console,
 * each under a 12px heading where two groups meet; the evaluate field at
 * the foot, live only while paused. No borders, no row motion.
 */
export function DebugView({
  phase,
  frames,
  variables,
  output,
  error,
  activeFrameId,
  onStep,
  onStop,
  onSelectFrame,
  onExpand,
  onEvaluate,
}: {
  phase: DebugPhase;
  frames: DebugFrame[];
  variables: DebugVariable[];
  output: string[];
  error: string | null;
  activeFrameId: number | null;
  onStep: (step: DebugStep) => void;
  onStop: () => void;
  onSelectFrame: (frame: DebugFrame) => void;
  onExpand: (variable: DebugVariable) => void;
  onEvaluate: (expr: string) => void;
}) {
  const [expr, setExpr] = useState("");
  const consoleBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = consoleBox.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [output]);

  const consoleGroup = (heading: string | null) => (
    <Group heading={heading} fill>
      <div ref={consoleBox} className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3 py-1 font-mono text-xs leading-relaxed text-muted-foreground" data-slot="debug-console">
            {output.map((line, i) => (
              <div key={i} className="break-all whitespace-pre-wrap">
                {line}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </Group>
  );

  // A session that ended keeps its console (its last words, a final error) under the hint.
  if (phase === "idle") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {error ? <ErrorLine text={error} /> : null}
        <p className="px-3 py-3 text-xs text-muted-foreground">⌃D in a Java file starts a session here</p>
        {output.length > 0 ? consoleGroup("Console") : null}
      </div>
    );
  }

  const paused = phase === "stopped";
  const stacked = frames.length > 0 || variables.length > 0;

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col" data-slot="debug-section">
        <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
          <Control label="Continue" icon={Play} enabled={paused} onClick={() => onStep("continue")} />
          <Control label="Step over" icon={ArrowTurnForward} enabled={paused} onClick={() => onStep("next")} />
          <Control label="Step into" icon={ArrowDownLong} enabled={paused} onClick={() => onStep("stepIn")} />
          <Control label="Step out" icon={ArrowUpLong} enabled={paused} onClick={() => onStep("stepOut")} />
          <StatusMark state={paused ? "paused" : "working"} className="ml-2 min-w-0 flex-1" />
          <Control label="Stop" icon={StopGlyph} enabled onClick={onStop} />
        </div>
        {error ? <ErrorLine text={error} /> : null}
        {frames.length > 0 ? (
          <Group heading="Call stack">
            <ScrollArea className="max-h-40 [&>[data-slot=scroll-area-viewport]]:max-h-40">
              <div className="flex flex-col px-1">
                {frames.map((f) => (
                  <ItemButton
                    key={f.id}
                    size="xs"
                    aria-current={f.id === activeFrameId ? "true" : undefined}
                    onClick={() => onSelectFrame(f)}
                    className={cn("min-h-7 flex-nowrap py-0 text-left", f.id === activeFrameId ? "bg-muted" : "hover:bg-foreground/5")}
                  >
                    <ItemContent className="min-w-0">
                      <span className={cn("block truncate text-[13px]", f.path ? "text-foreground" : "text-muted-foreground")}>{f.name}</span>
                    </ItemContent>
                    <ItemActions>
                      <span className="text-xs tabular-nums text-muted-foreground">{f.line}</span>
                    </ItemActions>
                  </ItemButton>
                ))}
              </div>
            </ScrollArea>
          </Group>
        ) : null}
        {variables.length > 0 ? (
          <Group heading="Variables">
            <ScrollArea className="max-h-48 [&>[data-slot=scroll-area-viewport]]:max-h-48">
              <div className="flex flex-col px-1 font-mono text-xs">
                {variables.map((v, i) => (
                  <VariableRow key={`${v.name}:${i}`} variable={v} onExpand={onExpand} />
                ))}
              </div>
            </ScrollArea>
          </Group>
        ) : null}
        {consoleGroup(stacked ? "Console" : null)}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = expr.trim();
            if (!q) return;
            setExpr("");
            onEvaluate(q);
          }}
          className="shrink-0 px-3 pt-2 pb-3"
        >
          <Input
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            placeholder="Evaluate…"
            disabled={!paused}
            aria-label="Evaluate expression"
            className="font-mono text-xs"
          />
        </form>
      </div>
    </TooltipProvider>
  );
}

/** A group 16px below the one above it, its 12px heading over its rows. */
function Group({ heading, fill, children }: { heading: string | null; fill?: boolean; children: ReactNode }) {
  return (
    <section className={cn("flex flex-col pt-1 [section+&]:pt-4", fill ? "min-h-0 flex-1" : "shrink-0")}>
      {heading ? <h3 className="px-3 pb-1 text-xs font-medium text-muted-foreground">{heading}</h3> : null}
      {children}
    </section>
  );
}

function VariableRow({ variable: v, onExpand }: { variable: DebugVariable; onExpand: (v: DebugVariable) => void }) {
  const body = (
    <>
      <span className="shrink-0 text-info">{v.name}</span>
      <span className="truncate text-muted-foreground">{v.value}</span>
    </>
  );
  const shape = "flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left";
  const indent = { paddingLeft: 8 + v.depth * 12 };
  if (!v.ref) {
    return (
      <div className={shape} style={indent}>
        {body}
      </div>
    );
  }
  return (
    <Button variant="ghost" onClick={() => onExpand(v)} className={cn(shape, "justify-start text-xs font-normal hover:bg-foreground/5")} style={indent}>
      {body}
    </Button>
  );
}

function ErrorLine({ text }: { text: string }) {
  return <p className="shrink-0 px-3 py-1 text-xs break-words text-destructive">{text}</p>;
}

function StopGlyph({ className }: { className?: string }) {
  return <Square className={cn(className, "size-2.5 fill-current")} />;
}

function Control({
  label,
  icon: Icon,
  enabled,
  onClick,
}: {
  label: string;
  icon: IconComponent | typeof StopGlyph;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label={label}
            disabled={!enabled}
            onClick={onClick}
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
