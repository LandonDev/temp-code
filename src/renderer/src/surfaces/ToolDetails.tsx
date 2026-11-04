import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, FileCode } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { copyText } from "../lib/clipboard";
import { playCue } from "../lib/sounds";
import { SwapIcon } from "../motion/IconSwap";
import { IconAction, useArmOnIntent } from "./transcript/IconAction";
import { sessionStore } from "../lib/tcserver/store";
import { omittedSizeLabel } from "../lib/wireBodies";
import type { Block } from "../lib/session";
import { kindOf } from "../lib/toolPhrase";
import { storeTitleOf, type TitleOf } from "../lib/threadMentions";
import { TodoList } from "./TodoListBlock";
import {
  getRawView,
  invocationBody,
  kvDisplay,
  OUTPUT_VISIBLE_LINES,
  outputText,
  parseJson,
  prettyInputKind,
  rawInput,
  scalar,
  setRawView,
  todoItems,
  toolOutput,
  liveToolOutput,
  rec,
} from "../lib/toolDetails";

/**
 * The body a tool row opens onto: what was asked, then what came back —
 * pretty by default (wrapper-free command, key/value JSON), verbatim behind
 * one ghost button in the corner that shows on hover. Mounted only once the
 * row opens, so a closed transcript never parses a byte of JSON. Output
 * shows only once the call has settled. No box of its own: the list around
 * the rows is the one border.
 */
export const ToolDetails = memo(function ToolDetails({
  block,
  titleOf = storeTitleOf,
}: {
  block: Block;
  titleOf?: TitleOf;
}) {
  const key = `raw:${block.tool?.callId ?? block.id}`;
  const [raw, setRawState] = useState(() => getRawView(key));
  const setRaw = (v: boolean) => {
    setRawView(key, v);
    setRawState(v);
  };
  const omitted = useRowBodies(block);
  const kind = kindOf(block);
  if (kind === "todo") {
    return (
      <div className="mt-1">
        <TodoList items={todoItems(block)} />
      </div>
    );
  }

  const out = toolOutput(block) ?? liveToolOutput(block);
  const parsedOut = !raw && out && !out.error ? parseJson(out.text) : undefined;
  const input = block.tool?.input;
  const pretty = !raw && prettyInputKind(block) && input !== undefined && typeof input !== "string";

  return (
    <div className="group/details relative flex min-w-0 flex-col">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={raw ? "Show formatted" : "Show raw"}
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
              className="absolute right-0 top-0 z-10 text-muted-foreground aria-pressed:bg-foreground/7 aria-pressed:text-foreground opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover/details:opacity-100 group-hover/details:delay-(--delay-hover) starting:opacity-0 focus-visible:opacity-100 focus-visible:delay-(--dur-instant) motion-reduce:transition-none"
            />
          }
        >
          <FileCode />
        </TooltipTrigger>
        <TooltipContent>{raw ? "Show formatted" : "Show raw"}</TooltipContent>
      </Tooltip>
      {pretty ? (
        <div className="pr-8">
          <PrettyJson value={input} titleOf={titleOf} />
        </div>
      ) : (
        <InvocationBlock className="pr-8" text={raw ? rawInput(block) : invocationBody(block) || rawInput(block)} />
      )}
      {omitted ? (
        <OmittedNote bytes={omitted.bytes} failed={!!omitted.failed} />
      ) : out ? (
        parsedOut !== undefined ? (
          <div className="mt-2">
            <PrettyJson value={parsedOut} titleOf={titleOf} />
          </div>
        ) : (
          <ToolOutputLines text={out.text} error={out.error} />
        )
      ) : null}
    </div>
  );
});

/**
 * Remote profile: a body that stayed on the server comes in once the row
 * opens. Answers what is still waiting there, if anything.
 */
export function useRowBodies(block: Block): NonNullable<Block["tool"]>["omitted"] {
  const omitted = block.tool?.omitted;
  useEffect(() => {
    if (omitted && !omitted.loading && !omitted.failed) void sessionStore.loadRowBodies(block);
  }, [block, omitted]);
  return omitted;
}

/** The line in place of a body that is still on the server. */
export function OmittedNote({ bytes, failed }: { bytes: number; failed: boolean }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-xs leading-5 text-muted-foreground first:mt-0">
      {failed ? null : <Spinner className="size-3.5" />}
      <span>
        {failed ? "Could not load" : "Loading"} {omittedSizeLabel(bytes)}
      </span>
    </div>
  );
}

/** What was asked, as text: one gray step below the body's card, no border, 12px mono on 20px like every code in a row's body. */
export function InvocationBlock({ text, children, className }: { text?: string; children?: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "min-w-0 rounded-lg bg-background px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      {children ?? text}
    </pre>
  );
}

/**
 * What came back, whole: muted mono under the block, red when the call
 * failed; nothing when empty. A long output scrolls inside its own box,
 * capped at 320px (`OUTPUT_VISIBLE_LINES` lines), so the row's height is
 * that cap once open; the transcript window measures it like any row. Copy
 * at the top right on hover takes the whole output.
 */
export function ToolOutputLines({ text, error }: { text: string; error: boolean }) {
  const out = outputText(text);
  const [armed, intent] = useArmOnIntent();
  // An empty output is no output: nothing, not a word saying so.
  if (!out.text.trim()) return null;
  const scrolls = out.lines > OUTPUT_VISIBLE_LINES;
  return (
    <div className="group/output relative mt-2 min-w-0 pr-8" {...intent}>
      <pre
        data-slot="tool-output"
        tabIndex={scrolls ? 0 : undefined}
        className={cn(
          "max-h-80 overflow-x-hidden overflow-y-auto font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] focus-ring",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {out.text}
      </pre>
      <CopyOutput text={out.text} armed={armed} />
    </div>
  );
}

function CopyOutput({ text, armed }: { text: string; armed: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    playCue("copy");
    void copyText(text).then(
      () => {
        setCopied(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };
  return (
    <IconAction
      label={copied ? "Copied" : "Copy output"}
      onClick={copy}
      armed={armed}
      className="absolute right-0 top-0 opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover/output:opacity-100 group-hover/output:delay-(--delay-hover) starting:opacity-0 focus-visible:opacity-100 focus-visible:delay-(--dur-instant) motion-reduce:transition-none"
    >
      <SwapIcon swapped={copied} from={<Copy className="size-3.5" />} to={<Check className="size-3.5" />} />
    </IconAction>
  );
}

function KVRows({ obj, titleOf }: { obj: Record<string, unknown>; titleOf: TitleOf }) {
  return (
    <div className="flex flex-col gap-0.5">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2 leading-5">
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{k}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-foreground">
            {kvDisplay(k, v, titleOf)}
          </span>
        </div>
      ))}
    </div>
  );
}

const PRETTY_ROW_CAP = 12;

function PrettyJson({ value, titleOf }: { value: unknown; titleOf: TitleOf }) {
  if (Array.isArray(value)) {
    const shown = value.slice(0, PRETTY_ROW_CAP);
    return (
      <div className="flex flex-col gap-2">
        {shown.map((v, n) =>
          v && typeof v === "object" ? (
            <KVRows key={n} obj={rec(v)} titleOf={titleOf} />
          ) : (
            <div key={n} className="text-[13px] leading-5 text-foreground">
              {scalar(v)}
            </div>
          ),
        )}
        {value.length > shown.length ? (
          <div className="text-[11px] tabular-nums text-muted-foreground">{value.length - shown.length} more</div>
        ) : null}
      </div>
    );
  }
  if (value && typeof value === "object") return <KVRows obj={rec(value)} titleOf={titleOf} />;
  return <div className="text-[13px] leading-5 text-foreground">{scalar(value)}</div>;
}
