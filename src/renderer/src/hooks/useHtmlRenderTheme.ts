import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_TOKENS,
  htmlRenderTheme,
  type HtmlRenderAppearance,
  type HtmlRenderTheme,
  type HtmlRenderTokens,
} from "@shared/htmlRender";
import { isLightScheme } from "../lib/appearance";
import { useColorScheme } from "./useColorScheme";

/**
 * The app's live theme as the variables an HTML render styles against. Read
 * from the root's computed custom properties (their var()s already
 * substituted), again on scheme changes and whenever <html>'s class or style
 * changes: a tint change sets --theme-hue inline and fires no event. Memoised
 * by value, so a frame only posts into its page when something changed.
 */
export function useHtmlRenderTheme(): HtmlRenderTheme {
  const scheme = useColorScheme();
  const [serial, setSerial] = useState(() => JSON.stringify(readTheme(scheme)));
  useEffect(() => {
    const update = () => setSerial(JSON.stringify(readTheme(isLightScheme() ? "light" : "dark")));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [scheme]);
  return useMemo(() => JSON.parse(serial) as HtmlRenderTheme, [serial]);
}

function readTheme(appearance: HtmlRenderAppearance): HtmlRenderTheme {
  const fallback = DEFAULT_TOKENS[appearance];
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, or: string) => style.getPropertyValue(name).trim() || or;
  const tokens: HtmlRenderTokens = {
    background: read("--color-background-base", fallback.background),
    foreground: read("--color-content", fallback.foreground),
    accent: read("--color-accent", fallback.accent),
    link: read("--link-color", fallback.link),
    success: read("--thread-success", fallback.success),
    warning: read("--thread-warning", fallback.warning),
    danger: read("--thread-danger", fallback.danger),
    info: read("--thread-info", fallback.info),
    violet: read("--thread-violet", fallback.violet),
    cyan: read("--thread-cyan", fallback.cyan),
    busy: read("--thread-busy", fallback.busy),
    fontSans: read("--font-sans", fallback.fontSans),
    fontMono: read("--font-mono", fallback.fontMono),
  };
  return htmlRenderTheme(tokens, appearance);
}
