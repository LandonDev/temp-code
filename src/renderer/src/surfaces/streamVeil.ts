import { useLayoutEffect, useRef, type RefObject } from "react";
import { VEIL } from "@renderer/lib/ease";

/**
 * Streaming veil — the mugen FadePainter algorithm.
 *
 * Newly appended text commits to layout instantly and dissolves in a
 * paint-only veil: rects the color of the backdrop are painted over the new
 * glyphs and fade out — opacity only, zero translate, layout untouched.
 *
 * - Cadence EMA of inter-append gaps: seed 160ms, ema = ema×0.7 + min(gap,1000)×0.3
 * - Per-chunk duration, fixed at arrival: clamp(ema × 3, 120ms, 400ms)
 * - Text alpha at progress p: 1 − (1−p)^1.6  (fast early reveal)
 * - Backed-up stream (3+ chunks fading): each speeds up by 1 + 0.3×(n−2)
 * - A chunk fades exactly once; a non-append rewrite (markdown re-resolving)
 *   re-veils only the changed tail
 * - The text under a cover reflowing (the host's width changes, or a rewrite
 *   moves what is already shown) finishes every fade at once, so no cover
 *   is left over the wrong glyphs; one ResizeObserver, only while a fade runs
 * - A selection inside the host is never painted over: no new cover, and the
 *   running ones finish
 * - Re-attaching to a streaming chat seeds the on-screen text as baseline
 */

export const EMA_SEED_MS = VEIL.seedMs;
export const MIN_FADE_MS = VEIL.minFadeMs;
export const MAX_FADE_MS = VEIL.maxFadeMs;
export const MAX_GAP_MS = VEIL.maxGapMs;

/** Next cadence estimate after a chunk landed `gapMs` after the previous one. */
export function nextCadence(ema: number, gapMs: number): number {
  return ema * 0.7 + Math.min(gapMs, MAX_GAP_MS) * 0.3;
}

/** Fade length for a chunk arriving at this cadence. */
export function fadeDuration(ema: number): number {
  return Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, ema * 3));
}

/** Playback rate for every active fade when `n` chunks are fading at once. */
export function playbackRate(n: number): number {
  return n >= 3 ? 1 + 0.3 * (n - 2) : 1;
}

/** Length of the shared prefix — settled text never re-animates. */
export function commonPrefix(a: string, b: string): number {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  return p;
}

function pointAt(
  root: HTMLElement,
  index: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue?.length ?? 0;
    if (index <= n + len) return { node: node as Text, offset: index - n };
    n += len;
  }
  return null;
}

/** Nearest non-transparent ancestor background — the veil must match the
 *  surface the glyphs sit on (panel, code card, …). */
function backdropOf(node: Node): string {
  let el: Element | null = node.parentElement;
  while (el) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
    el = el.parentElement;
  }
  return getComputedStyle(document.body).backgroundColor;
}

function speedUp(active: Set<Animation>): void {
  const rate = playbackRate(active.size);
  for (const a of active) a.playbackRate = rate;
}

/** Every fade ends now, and its cover with it. */
function finishAll(active: Set<Animation>): void {
  for (const a of [...active]) a.finish();
}

/** Whether the person holds a selection that reaches into the host. */
function selectionIn(host: HTMLElement): boolean {
  const selection = typeof getSelection === "function" ? getSelection() : null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return selection.getRangeAt(0).intersectsNode(host);
}

function veilRange(
  host: HTMLElement,
  from: number,
  to: number,
  duration: number,
  active: Set<Animation>,
  onIdle: () => void,
): void {
  const start = pointAt(host, from);
  if (!start) return;
  const hostRect = host.getBoundingClientRect();
  // Walk text nodes from the start point so each veil rect can take the
  // backdrop of its own element (code cards differ from the panel).
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let n = 0;
  let node: Node | null;
  let reached = false;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const len = text.nodeValue?.length ?? 0;
    const nodeStart = n;
    n += len;
    if (!reached) {
      if (node !== start.node) continue;
      reached = true;
    }
    if (nodeStart >= to) break;
    const a = node === start.node ? start.offset : 0;
    const b = Math.min(len, to - nodeStart);
    if (b <= a) continue;
    const range = document.createRange();
    range.setStart(text, a);
    range.setEnd(text, b);
    const bg = backdropOf(text);
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const cover = document.createElement("div");
      cover.style.cssText =
        `position:absolute;pointer-events:none;background:${bg};` +
        `left:${rect.left - hostRect.left}px;top:${rect.top - hostRect.top}px;` +
        `width:${rect.width}px;height:${rect.height}px;`;
      host.appendChild(cover);
      const anim = cover.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration,
        easing: VEIL.alpha,
        fill: "forwards",
      });
      active.add(anim);
      const done = (): void => {
        active.delete(anim);
        cover.remove();
        speedUp(active);
        if (active.size === 0) onIdle();
      };
      anim.onfinish = done;
      anim.oncancel = done;
    }
  }
  speedUp(active);
}

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Attach the veil to a container whose rendered text streams in. */
export function useStreamVeil(
  ref: RefObject<HTMLElement | null>,
  text: string,
  streaming: boolean | undefined,
): void {
  const prev = useRef<string | null>(null);
  const ema = useRef<number>(EMA_SEED_MS);
  const lastAt = useRef<number | null>(null);
  const active = useRef<Set<Animation>>(new Set());
  // Watches the host's width while a fade runs: a reflow moves the glyphs
  // out from under their covers.
  const watch = useRef<ResizeObserver | null>(null);
  const unwatch = (): void => {
    watch.current?.disconnect();
    watch.current = null;
  };
  const watchReflow = (host: HTMLElement): void => {
    if (watch.current || typeof ResizeObserver === "undefined") return;
    let width = host.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.width ?? host.clientWidth;
      if (next === width) return;
      width = next;
      finishAll(active.current);
    });
    observer.observe(host);
    watch.current = observer;
  };

  useLayoutEffect(() => () => {
    finishAll(active.current);
    unwatch();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rendered = el.textContent ?? "";
    // First sight (mount / re-attach) or a settled block: baseline, no fade.
    if (prev.current === null || !streaming || reducedMotion()) {
      prev.current = rendered;
      return;
    }
    const old = prev.current;
    if (rendered === old) return;
    prev.current = rendered;
    // A selection in the row is the person's: nothing paints over it.
    if (selectionIn(el)) {
      finishAll(active.current);
      return;
    }
    // Re-veil only past the common prefix — settled text never re-animates.
    const p = commonPrefix(old, rendered);
    // A rewrite of text already shown moves what the covers sit on.
    if (p < old.length) finishAll(active.current);
    if (p >= rendered.length) return;
    const now = performance.now();
    if (lastAt.current !== null) {
      ema.current = nextCadence(ema.current, now - lastAt.current);
    }
    lastAt.current = now;
    veilRange(el, p, rendered.length, fadeDuration(ema.current), active.current, unwatch);
    if (active.current.size > 0) watchReflow(el);
  }, [ref, text, streaming]);
}
