import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy } from "../chrome/icons";
import { copyText } from "../lib/clipboard";
import { highlight, highlightCached } from "../lib/highlight";
import { playCue } from "../lib/sounds";

/**
 * A fenced code block (ported from temp-code): language and copy button in
 * the header, IntelliJ Light / Darcula colouring from the shiki worker so
 * the main thread never tokenizes. Highlighting runs while the fence still
 * streams too, debounced so the worker is not hammered on every delta.
 * Keeps streamdown's `data-streamdown` hooks so index.css styles it as one
 * with tables and the rest of the markdown.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  incomplete = false,
  lineNumbers = true,
  startLine = 1,
  className,
}: {
  code: string;
  language: string;
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
        copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div
      data-streamdown="code-block"
      className={`my-4 flex flex-col overflow-hidden rounded-lg border ${className ?? ""}`}
    >
      <div
        data-streamdown="code-block-header"
        className="flex items-center justify-between gap-2"
      >
        <span>{lang || "plain text"}</span>
        <button
          type="button"
          onClick={copy}
          title={copied ? "Copied" : "Copy code"}
          aria-label={copied ? "Copied" : "Copy code"}
          className="-my-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-content/45 transition-colors hover:bg-content/8 hover:text-content/80"
        >
          {copied ? (
            <Check className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Copy className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      </div>
      <div
        data-streamdown="code-block-body"
        data-line-numbers={lineNumbers ? "" : undefined}
        style={lineNumbers ? { counterReset: `line ${startLine - 1}` } : undefined}
      >
        {html ? (
          <div className="code-block-shiki" dangerouslySetInnerHTML={{ __html: html }} />
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
