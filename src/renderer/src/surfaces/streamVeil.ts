import { useLayoutEffect, useRef, type RefObject } from "react";

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
 * - Re-attaching to a streaming chat seeds the on-screen text as baseline
 */

export const EMA_SEED_MS = 160;
export const MIN_FADE_MS = 120;
export const MAX_FADE_MS = 400;
export const MAX_GAP_MS = 1000;

/** eased progress = 1 − (1−p)^1.6, sampled for CSS linear() */
const ALPHA_EASING =
  "linear(0, 0.155, 0.3, 0.435, 0.558, 0.67, 0.769, 0.854, 0.924, 0.975, 1)";

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

function veilRange(
  host: HTMLElement,
  from: number,
  to: number,
  duration: number,
  active: Set<Animation>,
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
        easing: ALPHA_EASING,
        fill: "forwards",
      });
      active.add(anim);
      const done = (): void => {
        active.delete(anim);
        cover.remove();
        speedUp(active);
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
  const ema = useRef(EMA_SEED_MS);
  const lastAt = useRef<number | null>(null);
  const active = useRef<Set<Animation>>(new Set());

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
    // Re-veil only past the common prefix — settled text never re-animates.
    const p = commonPrefix(old, rendered);
    if (p >= rendered.length) return;
    const now = performance.now();
    if (lastAt.current !== null) {
      ema.current = nextCadence(ema.current, now - lastAt.current);
    }
    lastAt.current = now;
    veilRange(el, p, rendered.length, fadeDuration(ema.current), active.current);
  }, [ref, text, streaming]);
}
