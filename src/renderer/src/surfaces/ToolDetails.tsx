import { memo, useState } from "react";
import type { Block } from "../lib/session";
import { kindOf } from "../lib/toolPhrase";
import { storeTitleOf, type TitleOf } from "../lib/threadMentions";
import {
  getRawView,
  invocationBody,
  kvDisplay,
  outputLines,
  parseJson,
  prettyInputKind,
  rawInput,
  scalar,
  setRawView,
  todoItems,
  toolOutput,
  rec,
} from "../lib/toolDetails";

/**
 * The body a tool row opens onto: what was asked, then what came back —
 * pretty by default (wrapper-free command, key/value JSON), verbatim behind
 * one small `raw` toggle in the corner. Mounted only once the row opens,
 * so a closed transcript never parses a byte of JSON. Output shows only
 * once the call has settled.
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
  const kind = kindOf(block);
  if (kind === "todo") return <TodoBlock block={block} />;

  const out = toolOutput(block);
  const parsedOut = !raw && out && !out.error ? parseJson(out.text) : undefined;
  const input = block.tool?.input;

  return (
    <div className="relative mt-1 rounded-lg bg-content/[0.04]">
      <button
        type="button"
        onClick={() => setRaw(!raw)}
        title={raw ? "Formatted view" : "Verbatim invocation and output"}
        className="absolute right-2.5 top-1.5 z-10 text-[10px] font-medium text-content/40 transition-colors hover:text-content/70"
      >
        {raw ? "pretty" : "raw"}
      </button>
      <div className="px-3 py-1.5 pr-12">
        {raw ? (
          <Mono text={rawInput(block)} />
        ) : prettyInputKind(block) && input !== undefined && typeof input !== "string" ? (
          <PrettyJson value={input} titleOf={titleOf} />
        ) : (
          <Mono text={invocationBody(block) || rawInput(block)} />
        )}
      </div>
      {out ? (
        <div className="border-t border-content/10">
          {parsedOut !== undefined ? (
            <div className="px-3 py-1.5">
              <PrettyJson value={parsedOut} titleOf={titleOf} />
            </div>
          ) : (
            <OutputBlock text={out.text} error={out.error} />
          )}
        </div>
      ) : null}
    </div>
  );
});

const MONO = "font-mono text-[12px] leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere]";

function Mono({ text, className = "text-content/50" }: { text: string; className?: string }) {
  return <pre className={`${MONO} ${className}`}>{text}</pre>;
}

function KVRows({ obj, titleOf }: { obj: Record<string, unknown>; titleOf: TitleOf }) {
  return (
    <div className="space-y-px">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[12px] leading-[18px]">
          <span className="w-24 shrink-0 truncate text-content/40">{k}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-content">
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
      <div>
        {shown.map((v, n) => (
          <div key={n} className={n > 0 ? "mt-1 border-t border-content/10 pt-1" : undefined}>
            {v && typeof v === "object" ? (
              <KVRows obj={rec(v)} titleOf={titleOf} />
            ) : (
              <div className="text-[12px] leading-[18px] text-content">{scalar(v)}</div>
            )}
          </div>
        ))}
        {value.length > shown.length ? (
          <div className="pt-1 text-[11px] text-content/40">… {value.length - shown.length} more</div>
        ) : null}
      </div>
    );
  }
  if (value && typeof value === "object") return <KVRows obj={rec(value)} titleOf={titleOf} />;
  return <div className="text-[12px] leading-[18px] text-content">{scalar(value)}</div>;
}

function OutputBlock({ text, error }: { text: string; error: boolean }) {
  const { shown, more } = outputLines(text);
  return (
    <div className="px-3 py-1.5">
      <Mono text={shown.join("\n") || "(no output)"} className={error ? "text-danger" : "text-content"} />
      {more > 0 ? (
        <div className="text-[11px] leading-[18px] text-content/40">… {more} more lines</div>
      ) : null}
    </div>
  );
}

function TodoBlock({ block }: { block: Block }) {
  return (
    <div className="mt-1 space-y-0.5 rounded-lg bg-content/[0.04] px-3 py-1.5">
      {todoItems(block).map((t, n) => (
        <div
          key={n}
          className={`flex items-start gap-2 text-[12px] leading-[18px] ${
            t.status === "completed" ? "text-content/50" : "text-content"
          }`}
        >
          <span className="w-3 shrink-0 text-center text-content/40">
            {t.status === "completed" ? "✓" : t.status === "in_progress" ? "›" : "·"}
          </span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
