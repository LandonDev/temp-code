import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "../chrome/icons";
import { copyText } from "../lib/clipboard";
import { highlight, highlightCached } from "../lib/highlight";
import { grammarFor } from "../lib/highlightLanguages";
import { playCue } from "../lib/sounds";
import { SwapIcon } from "../motion/IconSwap";
import { IconAction, useArmOnIntent } from "./transcript/IconAction";

/**
 * A fenced code block, quiet: a 28px header with the fence's file path,
 * else the language when the transcript colours it; plain text and an
 * unknown language have no header at all, the code padded 12px on every
 * side under a floating copy button. Copy on hover at the top right, its
 * 4px corner concentric with the card's 8px. The code in 13px mono
 * coloured by weight on the transcript's neutral theme
 * (lib/transcriptCodeTheme.ts) from the shiki worker, so the main thread
 * never tokenizes. Line numbers only when the fence asks. Highlighting
 * runs while the fence still streams too, throttled (the first run at once,
 * then at most one every HIGHLIGHT_EVERY_MS, never put off by a delta), and
 * until the answer for the newest text lands the block shows the coloured
 * lines it has and the lines past them plain, so a new line never waits and
 * colour never leaves. Keeps streamdown's `data-streamdown` hooks so
 * transcript/markdown.css frames it like a table: one card, one hairline.
 */
/** How long a code block's Copy holds its check (a message's holds 2s). */
export const COPIED_MS = 1200;

/** How often a streaming fence asks the worker to colour it, at most. */
export const HIGHLIGHT_EVERY_MS = 150;

type Colour = { code: string; html: string };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The colouring of an earlier text applied to the current one: the coloured
 * lines that still read the same, then the rest as plain lines in the same
 * `<pre><code>`. Null when no line survives or the markup is not shiki's.
 */
export function colourPrefix(colour: Colour, code: string): string | null {
  const open = colour.html.indexOf("<code>");
  const close = colour.html.lastIndexOf("</code>");
  if (open < 0 || close < open) return null;
  const inner = colour.html.slice(open + "<code>".length, close);
  const coloured = inner.split(/(?=<span class="line")/);
  const was = colour.code.split("\n");
  if (coloured.length !== was.length) return null;
  const now = code.split("\n");
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same++;
  if (same === 0) return null;
  const plain = now.slice(same).map((line) => `<span class="line">${escapeHtml(line)}</span>`);
  return colour.html.slice(0, open + "<code>".length) + coloured.slice(0, same).join("") + plain.join("") + colour.html.slice(close);
}

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
  const heading = label ?? (grammarFor(lang) ? lang : null);
  // A remount of a block the worker already coloured paints coloured.
  const [colour, setColour] = useState<Colour | null>(() => {
    const known = highlightCached(clean, lang);
    return known ? { code: clean, html: known } : null;
  });
  const throttle = useRef({ last: -Infinity, timer: 0, code: clean, lang, alive: true });
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const [armed, intent] = useArmOnIntent();

  useEffect(() => {
    const t = throttle.current;
    t.code = clean;
    t.lang = lang;
    const run = () => {
      t.last = performance.now();
      const code = t.code;
      const language = t.lang;
      const keep = (html: string) =>
        setColour((cur) => (cur && cur.code === code && cur.html === html ? cur : { code, html }));
      const known = highlightCached(code, language);
      if (known !== undefined) {
        keep(known);
        return;
      }
      void highlight(code, language).then((h) => {
        if (t.alive && h) keep(h);
      });
    };
    if (!incomplete) {
      if (t.timer) window.clearTimeout(t.timer);
      t.timer = 0;
      run();
      return;
    }
    // Leading and trailing: at once when the last run is old enough, else
    // once the interval is up, for whatever the text is by then.
    if (t.timer) return;
    const wait = t.last + HIGHLIGHT_EVERY_MS - performance.now();
    if (wait <= 0) run();
    else
      t.timer = window.setTimeout(() => {
        t.timer = 0;
        run();
      }, wait);
  }, [clean, lang, incomplete]);

  useEffect(() => {
    const t = throttle.current;
    t.alive = true;
    return () => {
      t.alive = false;
      if (t.timer) window.clearTimeout(t.timer);
      t.timer = 0;
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const html = !colour ? null : colour.code === clean ? colour.html : colourPrefix(colour, clean);

  const copy = () => {
    playCue("copy");
    void copyText(clean).then(
      () => {
        setCopied(true);
        if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {},
    );
  };

  const copyButton = (
    <IconAction
      label={copied ? "Copied" : "Copy code"}
      onClick={copy}
      armed={armed}
      className={`rounded-sm opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover/code:opacity-100 group-hover/code:delay-(--delay-hover) starting:opacity-0 focus-visible:opacity-100 focus-visible:delay-(--dur-instant) motion-reduce:transition-none ${
        heading ? "" : "absolute right-1 top-1 z-10"
      }`}
    >
      <SwapIcon swapped={copied} from={<Copy className="size-3.5" />} to={<Check className="size-3.5" />} />
    </IconAction>
  );

  return (
    <div
      data-streamdown="code-block"
      className={`group/code relative flex flex-col ${className ?? ""}`}
      {...intent}
    >
      {heading ? (
        <div
          data-streamdown="code-block-header"
          className="flex h-7 items-center justify-between gap-2 pl-3 pr-1"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground">{heading}</span>
          {copyButton}
        </div>
      ) : (
        copyButton
      )}
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
