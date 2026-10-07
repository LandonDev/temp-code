import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  htmlRenderPageUrl,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderReference,
} from "@shared/htmlRender";
import { Maximize2 } from "../chrome/icons";
import { useHtmlRenderTheme } from "../hooks/useHtmlRenderTheme";
import { openHtmlRenderOverlay } from "./HtmlRenderOverlay";

/**
 * An agent's HTML page inline in the thread (ported from T3 Code): the page
 * itself on the thread's own background, at main's measured height for this
 * width until the page reports its own. The box reserves its height before
 * the page loads, so nothing below it moves.
 */
export const HtmlRenderRow = memo(function HtmlRenderRow({
  reference,
}: {
  reference: HtmlRenderReference;
}) {
  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (box.clientWidth > 0) setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Fonts can wrap a page taller than main measured it; a frame left short
  // would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(reference, width, contentHeight);
  return (
    <div ref={boxRef} className="group/html-render relative my-1" style={{ height }}>
      <HtmlRenderDocument
        src={htmlRenderPageUrl(reference)}
        title={reference.title}
        className="block size-full"
        onContentHeight={setContentHeight}
      />
      <button
        type="button"
        aria-label="Open page"
        onClick={() => openHtmlRenderOverlay(reference)}
        className="pressable absolute right-2 top-2 grid size-7 place-items-center rounded-md bg-background-base/80 text-content/70 opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover/html-render:opacity-100"
      >
        <Maximize2 className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
});

/**
 * A sandboxed agent HTML page in the app theme. The page reads the theme from
 * its URL fragment before first paint, then follows changes posted to its
 * bootstrap. The first URL is kept for the frame's lifetime: a new src would
 * reload the page.
 */
export function HtmlRenderDocument(props: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  /** Receives the page's content height whenever it changes, so an inline frame can fit it. */
  readonly onContentHeight?: (height: number) => void;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);
  // The page cannot open windows itself (the window-open handler sends any
  // window to the browser). It asks the frame, which opens the link only
  // while this frame has focus and the reader has just used the app, so a
  // page cannot open links on load.
  useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);
  const { onContentHeight } = props;
  // A page posts its height once per change, so listen from the commit that
  // inserts the frame; a passive effect could run after a fast page's first post.
  useLayoutEffect(() => {
    if (onContentHeight === undefined) return;
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) {
        onContentHeight(height);
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [onContentHeight]);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={props.title}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts allow-forms"
      loading="lazy"
      onLoad={() => {
        setLoaded(true);
        // Covers a theme change that landed while the page was loading.
        postTheme();
      }}
      className={`border-0 ${props.className ?? ""}`}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank document a frame starts with would flash white in
      // dark mode. Once the page is in, its prefers-color-scheme follows the app.
      style={{ colorScheme: loaded ? theme.appearance : "light" }}
    />
  );
}
