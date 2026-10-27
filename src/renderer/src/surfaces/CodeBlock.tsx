import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "../chrome/icons";
import { copyText } from "../lib/clipboard";
import { highlight, highlightCached } from "../lib/highlight";
import { playCue } from "../lib/sounds";
import { IconAction, SwapIcon, useArmOnIntent } from "./transcript/IconAction";

/**
 * A fenced code block, quiet: the language (or the fence's file path) at
 * the top left, copy on hover at the top right, the code in 13px mono
 * coloured by weight on the transcript's neutral theme
 * (lib/transcriptCodeTheme.ts) from the shiki worker, so the main thread
 * never tokenizes. Line numbers only when the fence asks. Highlighting
 * runs while the fence still streams too, debounced so the worker is not
 * hammered on every delta. Keeps streamdown's `data-streamdown` hooks so
 * transcript/markdown.css frames it like a table: one card, one hairline.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  label,
  incomplete = false,
  lineNumbers = false,
  startLine = 1,
  className,
}: {
  code: string;
  language: string;
  /** Replaces the language at the top left (the fence's file path). */
  label?: ReactNode;
  incomplete?: boolean;
  lineNumbers?: boolean;
  startLine?: number;
  className?: string;
}) {
  const clean = code.replace(/\n$/, "");
  const lang = language.trim().toLowerCase();
  // A remount of a block the worker already coloured paints coloured.
  const [html, setHtml] = useState<string | null>(() => highlightCached(clean, lang) ?? null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const [armed, intent] = useArmOnIntent();

  useEffect(() => {
    let alive = true;
    const run = () => {
      const known = highlightCached(clean, lang);
      if (known !== undefined) {
        setHtml((cur) => (cur === known ? cur : known));
        return;
      }
      void highlight(clean, lang).then((h) => {
        if (alive && h) setHtml(h);
      });
    };
    const timer = incomplete ? window.setTimeout(run, 150) : (run(), 0);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [clean, lang, incomplete]);

  useEffect(
    () => () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = () => {
    playCue("copy");
    void copyText(clean).then(
      () => {
        setCopied(true);
        if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  return (
    <div
      data-streamdown="code-block"
      className={`group/code flex flex-col ${className ?? ""}`}
      {...intent}
    >
      <div
        data-streamdown="code-block-header"
        className="flex h-8 items-center justify-between gap-2 pl-3 pr-1"
      >
        <span className="min-w-0 truncate text-xs text-muted-foreground">{label ?? lang}</span>
        <IconAction
          label={copied ? "Copied" : "Copy code"}
          onClick={copy}
          armed={armed}
          className="opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover/code:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
        >
          <SwapIcon swapped={copied} from={<Copy className="size-3.5" />} to={<Check className="size-3.5" />} />
        </IconAction>
      </div>
      <div
        data-streamdown="code-block-body"
        data-line-numbers={lineNumbers ? "" : undefined}
        style={lineNumbers ? { counterReset: `line ${startLine - 1}` } : undefined}
      >
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>
              {clean.split("\n").map((line, n) => (
                <span key={n} className="line">
                  {line}
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
});
