import {
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Streamdown,
  useIsCodeFenceIncomplete,
  type Components,
} from "streamdown";
import type { PluggableList } from "unified";
import { CodeBlock } from "./CodeBlock";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { FileRefMenu } from "./FileRefMenu";
import { createLazyMermaidPlugin } from "./mermaidPlugin";
import { cachedParse, restoreHast } from "../lib/markdownCache";
import { useMarkdownReady } from "../lib/markdownParse";
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS } from "../lib/markdownPipeline";
import { parseFileHref } from "../lib/paths";
import type { OpenFileFn } from "../lib/search";
import {
  hasThreadMention,
  threadIdFromHref,
  threadMentionsToLinks,
  useThreadTitles,
} from "../lib/threadMentions";
import { isAtxHeadingLine } from "../lib/markdownSource";
import { useColorScheme } from "../hooks/useColorScheme";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useSmoothText } from "./smoothText";
import { useStreamVeil } from "./streamVeil";
import { useTranscriptHost } from "./transcriptSession";

const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
} as const;

const mermaid = createLazyMermaidPlugin({
  config: {
    ...MERMAID_BASE_CONFIG,
    theme: "dark",
  },
});

const MARKDOWN_PLUGINS = { mermaid };

// Settled blocks parse through the render cache (lib/markdownCache.ts):
// the parser is bypassed and the last rehype step hands back the cached
// tree, so a remount is a lookup. The tree gets there from the parse
// worker (lib/markdownParse.ts): a settled row waits for its answer and
// never runs the parser on this thread. Streaming blocks keep the plain
// lists (lib/markdownPipeline.ts, shared with the worker). Both pairs are
// module constants: streamdown keys its processor cache and Block memo on
// plugin identity.
const CACHED_REMARK_PLUGINS: PluggableList = [...MARKDOWN_REMARK_PLUGINS, cachedParse];
const CACHED_REHYPE_PLUGINS: PluggableList = [...MARKDOWN_REHYPE_PLUGINS, restoreHast];

const FileOpenContext = createContext<{
  cwd?: string;
  onOpenFile?: OpenFileFn;
}>({});

/** How a `@thread:<id>` chip opens its thread; the transcript provides it once. */
export const SelectSessionContext = createContext<((sessionId: string) => void) | undefined>(
  undefined,
);

function openAt(
  onOpenFile: OpenFileFn,
  href: { path: string; line?: number; column?: number },
  threadHost?: string,
) {
  onOpenFile(
    href.path,
    href.line ? { line: href.line, column: href.column } : undefined,
    threadHost ? { environmentId: threadHost } : undefined,
  );
}

const LANGUAGE_FROM_EXT: Record<string, string> = {
  sh: "bash",
  zsh: "bash",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  js: "javascript",
  md: "markdown",
  yml: "yaml",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
};

type MarkdownLinkProps = ComponentProps<"a"> & { node?: unknown };

function MarkdownLink({
  href,
  children,
  className,
  node: _node,
  onClick,
  ...props
}: MarkdownLinkProps) {
  const { cwd, onOpenFile } = useContext(FileOpenContext);
  const threadHost = useTranscriptHost();
  const onSelectSession = useContext(SelectSessionContext);
  const threadId = threadIdFromHref(href);
  const file = href && !threadId ? parseFileHref(href, cwd) : undefined;

  const anchor = (
    <a
      href={href}
      className={`text-accent underline-offset-2 hover:underline ${className ?? ""}`}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (threadId && onSelectSession) {
          event.preventDefault();
          onSelectSession(threadId);
          return;
        }
        if (file && onOpenFile) {
          event.preventDefault();
          openAt(onOpenFile, file, threadHost);
          return;
        }
        if (!href || !/^https?:\/\//i.test(href)) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </a>
  );
  return file ? <FileRefMenu target={file.path} cwd={cwd} onOpenFile={onOpenFile}>{anchor}</FileRefMenu> : anchor;
}

type MarkdownCodeProps = ComponentProps<"code"> & { node?: unknown };

function MarkdownCode({
  children,
  className,
  node,
  ...props
}: MarkdownCodeProps) {
  const incomplete = useIsCodeFenceIncomplete();
  const block = Object.prototype.hasOwnProperty.call(props, "data-block");
  if (!block) {
    const text = textContent(children);
    const fileName = inlineFileName(text);
    const { cwd, onOpenFile } = useContext(FileOpenContext);
    const threadHost = useTranscriptHost();
    const file = fileName ? parseFileHref(text, cwd) : undefined;
    const open = file && onOpenFile ? () => openAt(onOpenFile, file, threadHost) : undefined;
    const code = (
      <code
        {...props}
        className={`rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground ${
          open ? "cursor-pointer decoration-muted-foreground underline-offset-2 hover:underline" : ""
        } ${className ?? ""}`}
        role={open ? "link" : undefined}
        tabIndex={open ? 0 : undefined}
        onClick={open}
        onKeyDown={
          open
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  open();
                }
              }
            : undefined
        }
      >
        {children}
      </code>
    );
    return file ? <FileRefMenu target={file.path} cwd={cwd} onOpenFile={onOpenFile}>{code}</FileRefMenu> : code;
  }

  const meta = codeMeta(node);
  const fence = parseCodeFence(className, meta);
  if (fence.language.toLowerCase() === "mermaid") {
    return (
      <MermaidBlock code={textContent(children)} incomplete={incomplete} />
    );
  }
  // Line numbers only when the fence asks: `lineNumbers`, or a start line.
  const lineNumbers =
    !/\bnoLineNumbers\b/.test(meta) && (/\blineNumbers\b/.test(meta) || fence.startLine !== undefined);

  return (
    <CodeBlock
      className={className}
      code={textContent(children)}
      incomplete={incomplete}
      language={fence.language}
      label={fence.filePath ? <MarkdownCodePath path={fence.filePath} /> : undefined}
      lineNumbers={lineNumbers}
      startLine={fence.startLine}
    />
  );
}

const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  code: MarkdownCode,
} satisfies Components;

/** Transcript prose is 15/1.6 (24px lines, transcriptRows' PROSE_LINE);
 *  panels and dialogs read it at 14/24. */
const SIZE_CLASS = { prose: "text-[15px] leading-[1.6]", compact: "text-sm leading-6" } as const;

export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  streaming,
  className,
  size = "prose",
  cwd,
  onOpenFile,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
  size?: keyof typeof SIZE_CLASS;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const fileOpen = useMemo(() => ({ cwd, onOpenFile }), [cwd, onOpenFile]);
  // A mentioned thread reads as its title, linking back to the thread.
  const titleOf = useThreadTitles(text);
  const source = hasThreadMention(text) ? threadMentionsToLinks(text, titleOf) : text;
  // Coarse chunks glide out through a reveal buffer, and each small step
  // dissolves in under the paint-only veil. History mounts at full text.
  const shown = useSmoothText(source, streaming);
  const veilRef = useRef<HTMLDivElement>(null);
  useStreamVeil(veilRef, shown, streaming);
  const settled = !streaming && shown === source;
  // A row that mounts settled (history, a row scrolled into view) mounts
  // its tree once the worker has parsed it; until then the text holds the
  // row's place, unseen, in the same measure. A row that streamed here is
  // already parsed on this thread, and settles in place as before: taking
  // it down for the worker would remount its tree and flicker.
  const streamedHere = useRef(!!streaming);
  if (streaming) streamedHere.current = true;
  const ready = useMarkdownReady(shown, settled && !streamedHere.current);
  return (
    <FileOpenContext.Provider value={fileOpen}>
      {/* Relative: the veil paints absolutely-positioned covers over new glyphs. */}
      <div ref={veilRef} className="relative min-w-0">
        {!ready ? (
          <pre
            aria-hidden
            className={`agent-markdown invisible min-w-0 whitespace-pre-wrap break-words font-sans ${SIZE_CLASS[size]} ${className ?? ""}`}
          >
            {shown}
          </pre>
        ) : (
        <Streamdown
          className={`agent-markdown min-w-0 font-sans ${SIZE_CLASS[size]} ${className ?? ""}`}
          components={MARKDOWN_COMPONENTS}
          controls={false}
          isAnimating={!!streaming || shown.length < source.length}
          plugins={MARKDOWN_PLUGINS}
          remarkPlugins={settled ? CACHED_REMARK_PLUGINS : MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={settled ? CACHED_REHYPE_PLUGINS : MARKDOWN_REHYPE_PLUGINS}
        >
          {shown}
        </Streamdown>
        )}
      </div>
    </FileOpenContext.Provider>
  );
});

export const MarkdownPreview = memo(function MarkdownPreview({
  text,
  streaming,
  cwd,
  onOpenFile,
}: {
  text: string;
  streaming?: boolean;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();

  return (
    <div
      ref={lockOverscroll}
      className="markdown-preview h-full overflow-y-auto overscroll-none [overflow-anchor:none]"
    >
      <div className="px-6 py-8">
        <AgentMarkdown
          text={text}
          streaming={streaming}
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      </div>
    </div>
  );
});

export const MarkdownSource = memo(function MarkdownSource({
  text,
}: {
  text: string;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();

  return (
    <div
      ref={lockOverscroll}
      className="markdown-preview h-full overflow-y-auto overscroll-none [overflow-anchor:none]"
    >
      <pre className="min-h-full min-w-0 whitespace-pre-wrap wrap-break-word px-4 py-3 font-mono text-[13px] leading-5 text-content">
        <MarkdownSourceHighlight text={text} />
      </pre>
    </div>
  );
});

export function MarkdownSourceHighlight({ text }: { text: string }) {
  if (!text) return null;
  return (
    <>
      {text.split(/(\n)/).map((part, index) =>
        part === "\n" ? (
          "\n"
        ) : isAtxHeadingLine(part) ? (
          <span key={index} className="markdown-source-heading">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function MermaidBlock({
  code,
  incomplete,
}: {
  code: string;
  incomplete: boolean;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const colorScheme = useColorScheme();

  useEffect(() => {
    if (incomplete) {
      setSvg(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    const id = `mermaid-${Math.abs(hashCode(code)).toString(36)}-${Date.now().toString(36)}`;
    void mermaid
      .getMermaid({
        ...MERMAID_BASE_CONFIG,
        theme: colorScheme === "light" ? "default" : "dark",
      })
      .render(id, code)
      .then((result) => {
        if (cancelled) return;
        setSvg(result.svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, incomplete, colorScheme]);

  if (incomplete || failed) {
    return (
      <CodeBlock code={code} incomplete={incomplete} language="mermaid" />
    );
  }

  if (!svg) {
    return (
      <div className="my-4 h-32 motion-safe:animate-pulse rounded-lg border border-border bg-card" />
    );
  }

  return (
    <div
      className="mermaid-block my-4 overflow-x-auto rounded-lg border border-border bg-card p-3"
      data-streamdown="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function codeMeta(node: unknown): string {
  if (!node || typeof node !== "object" || !("properties" in node)) return "";
  const properties = node.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    !("metastring" in properties)
  ) {
    return "";
  }
  return typeof properties.metastring === "string" ? properties.metastring : "";
}

function textContent(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) {
    return textContent(value.props.children);
  }
  return "";
}

function parseCodeFence(
  className: string | undefined,
  meta: string,
): {
  language: string;
  startLine?: number;
  filePath?: string;
} {
  const raw = className?.match(/\blanguage-([^\s]+)/)?.[1] ?? "";
  const metaStart = meta.match(/\bstartLine=(\d+)/);
  const metaStartLine = metaStart ? Number(metaStart[1]) : undefined;

  const citation = raw.match(/^(\d+):(\d+):(.+)$/);
  if (citation) {
    const filePath = citation[3];
    const fileName = filePath.split(/[/\\]/).filter(Boolean).pop() ?? filePath;
    return {
      language: languageFromFileName(fileName),
      startLine: Number(citation[1]),
      filePath,
    };
  }

  if (/[/\\]/.test(raw)) {
    const fileName = raw.split(/[/\\]/).filter(Boolean).pop() ?? raw;
    return {
      language: languageFromFileName(fileName),
      startLine: metaStartLine,
      filePath: raw,
    };
  }

  return { language: raw, startLine: metaStartLine };
}

function MarkdownCodePath({ path }: { path: string }) {
  const { cwd, onOpenFile } = useContext(FileOpenContext);
  const threadHost = useTranscriptHost();
  const file = parseFileHref(path, cwd);
  if (!file || !onOpenFile) {
    return <span className="markdown-code-path">{path}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="link"
            size="xs"
            className="markdown-code-path h-auto max-w-full justify-start px-0 font-normal text-muted-foreground hover:text-foreground"
            onClick={() => openAt(onOpenFile, file, threadHost)}
          />
        }
      >
        <span className="truncate">{path}</span>
      </TooltipTrigger>
      <TooltipContent>{file.path}</TooltipContent>
    </Tooltip>
  );
}

function languageFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = lower.includes(".")
    ? lower.slice(lower.lastIndexOf(".") + 1)
    : lower;
  return LANGUAGE_FROM_EXT[ext] ?? ext;
}

function inlineFileName(value: string): string | undefined {
  const text = value.trim();
  if (!text || text.length > 240 || /\s/.test(text)) return undefined;

  const withoutLocation = text.replace(
    /(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/,
    "",
  );
  const fileName = withoutLocation.split(/[/\\]/).filter(Boolean).pop();
  if (!fileName || !/^[\w@+().-]+$/.test(fileName)) return undefined;

  const lower = fileName.toLowerCase();
  if (
    lower === "dockerfile" ||
    lower === "makefile" ||
    lower === "gemfile" ||
    lower === "license"
  ) {
    return fileName;
  }

  const extension = fileName.split(".").pop();
  return extension && /^[a-z][a-z0-9+-]{0,11}$/i.test(extension)
    ? fileName
    : undefined;
}
