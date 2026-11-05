import { memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Copy } from "../chrome/icons";
import { copyText } from "../lib/clipboard";
import { highlight, highlightCached } from "../lib/highlight";
import { useHeightGlide } from "../lib/heightGlide";
import { grammarFor } from "../lib/highlightLanguages";
import { STEP_CLASS, StreamRevealContext } from "../lib/streamReveal";
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
 * colour never leaves. Every line is an element of its own, its coloured
 * markup swapped inside it, so a recolour or a new line never replaces
 * another line. While its row streams (StreamRevealContext) a new line fades
 * in whole, the body glides to its new height on --dur-base, and a fence
 * born mid-stream rises in (`stream-rise`). Keeps streamdown's
 * `data-streamdown` hooks so transcript/markdown.css frames it like a table:
 * one card, one hairline.
 */
/** How long a code block's Copy holds its check (a message's holds 2s). */
export { COPIED_MS } from "../lib/clipboard";
import { COPIED_MS } from "../lib/clipboard";

/** How often a streaming fence asks the worker to colour it, at most. */
export const HIGHLIGHT_EVERY_MS = 150;

type Colour = { code: string; html: string };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A block's markup taken apart: the shiki `pre`'s attributes (none for
 *  plain lines) and each line's inner HTML. */
export type CodeLines = { className?: string; style?: CSSProperties; tabIndex?: number; lines: string[] };

const LINE_OPEN = '<span class="line">';
const LINE_CLOSE = "</span>";

/**
 * shiki's `<pre class style tabindex><code><span class="line">…</span>…
 * </code></pre>` taken apart: the pre's class, style (as an object) and
 * tab stop, and each line's inner HTML. Null when the markup is not that.
 */
export function splitColoured(html: string): CodeLines | null {
  const match = /^<pre([^>]*)><code>([\s\S]*)<\/code><\/pre>$/.exec(html.trim());
  if (!match) return null;
  const [, attrs, inner] = match;
  const lines: string[] = [];
  for (const piece of inner === "" ? [] : inner.split(/(?=<span class="line">)/)) {
    if (!piece.startsWith(LINE_OPEN) || !piece.endsWith(LINE_CLOSE)) return null;
    lines.push(piece.slice(LINE_OPEN.length, -LINE_CLOSE.length));
  }
  const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
  const tab = attr("tabindex");
  return { className: attr("class"), style: parseStyle(attr("style")), tabIndex: tab === undefined ? undefined : Number(tab), lines };
}

/** `a-b:c;--d:e` as React's style object. */
function parseStyle(style: string | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const out: Record<string, string> = {};
  for (const rule of style.split(";")) {
    const colon = rule.indexOf(":");
    if (colon < 0) continue;
    const name = rule.slice(0, colon).trim();
    out[name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = rule.slice(colon + 1).trim();
  }
  return out as CSSProperties;
}

/** Each line of `code` escaped, with no colour yet. */
function plainLines(code: string): CodeLines {
  return { lines: code.split("\n").map(escapeHtml) };
}

/**
 * The colouring of an earlier text applied to the current one: the coloured
 * lines that still read the same, then the rest plain, under the colouring's
 * `pre`. Null when the markup is not shiki's.
 */
export function colourLines(colour: Colour, code: string): CodeLines | null {
  const split = splitColoured(colour.html);
  if (!split) return null;
  if (colour.code === code) return split;
  const was = colour.code.split("\n");
  if (split.lines.length !== was.length) return null;
  const now = code.split("\n");
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same++;
  return { ...split, lines: [...split.lines.slice(0, same), ...now.slice(same).map(escapeHtml)] };
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

  const view = useMemo(() => (colour ? colourLines(colour, clean) : null) ?? plainLines(clean), [colour, clean]);
  // While the row streams: which lines are still fading in, and the body's
  // glide by the line; a row that mounts settled has no reveal.
  const reveal = useContext(StreamRevealContext);
  const fresh = reveal ? reveal.freshLines(clean, view.lines.length) : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  useHeightGlide(bodyRef, view.lines.length, { enabled: !!reveal?.isArmed(), curve: "base" });

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

  // The reveal rides a wrapper, so the button keeps its own hover fill's transition.
  const copyButton = (
    <span
      data-reveal="copy-code"
      className={`flex opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover/code:opacity-100 group-hover/code:delay-(--delay-hover) starting:opacity-0 has-focus-visible:opacity-100 has-focus-visible:delay-(--dur-instant) motion-reduce:transition-opacity ${heading ? "" : "absolute right-1 top-1 z-10"}`}
    >
      <IconAction label={copied ? "Copied" : "Copy code"} onClick={copy} armed={armed} className="rounded-sm">
        <SwapIcon swapped={copied} from={<Copy className="size-3.5" />} to={<Check className="size-3.5" />} />
      </IconAction>
    </span>
  );

  return (
    <div
      data-streamdown="code-block"
      className={`group/code relative flex flex-col ${fresh?.[0] ? "stream-rise" : ""} ${className ?? ""}`}
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
        ref={bodyRef}
        data-streamdown="code-block-body"
        data-line-numbers={lineNumbers ? "" : undefined}
        style={lineNumbers ? { counterReset: `line ${startLine - 1}` } : undefined}
      >
        <pre className={view.className} style={view.style} tabIndex={view.tabIndex}>
          <code>
            {view.lines.map((line, n) => (
              <span key={n} className={fresh?.[n] ? `line ${STEP_CLASS}` : "line"} dangerouslySetInnerHTML={{ __html: line }} />
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
});
