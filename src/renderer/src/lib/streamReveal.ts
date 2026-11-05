/**
 * The phrase fade: each step of a streaming reply (smoothText's whole-word
 * steps, about every 100 ms) fades in as one span over `--dur-reveal`,
 * linear, with no stagger inside it, the way Claude's reveal does. A rehype
 * plugin on the streaming path only (AgentMarkdown's plugin list while the
 * row is not settled), one per AgentMarkdown so streamdown's processor and
 * Block memo, keyed on plugin identity, stay put for the row.
 *
 * It keeps a ledger per streamdown block, keyed by the block's first 32
 * rendered characters (text outside `pre`, `svg` and math): each pass, the
 * block's rendered text past what the ledger holds is a new step. Every
 * step's text is wrapped in a span (`data-reveal-step` its index) so the spans keep
 * their elements, and so their fades, as the block grows; only a step
 * younger than REVEAL.fadeMs carries `.stream-step`, which runs the fade. A
 * block whose text no longer starts with its ledger's (a paragraph turning
 * into a table) starts a new ledger, so the reparsed block fades in whole.
 * Text the row already held when it mounted is shown, not faded.
 *
 * Code is not prose: a fence's lines fade in one element each
 * (surfaces/CodeBlock.tsx), timed by `lineTimes`, a ledger per fence keyed
 * the same way by its code's first characters.
 */
import { createContext } from "react";
import type { Element, ElementContent, Root, RootContent } from "hast";
import type { Plugin } from "unified";
import { REVEAL } from "./ease";

type Step = { from: number; to: number; at: number };
type Ledger = { text: string; steps: Step[] };

/** The ledger key: a block's first rendered characters. */
export const LEDGER_KEY_CHARS = 32;

export const STEP_CLASS = "stream-step";

/** Elements whose text is not prose: code, drawings, math. */
function skipped(node: Element): boolean {
  if (node.tagName === "pre" || node.tagName === "svg" || node.tagName === "math") return true;
  const className = node.properties?.className;
  return Array.isArray(className) && className.some((name) => String(name).startsWith("katex"));
}

/** The block's rendered prose text, in document order. */
export function renderedText(tree: Root | Element): string {
  let out = "";
  const walk = (node: Root | RootContent): void => {
    if (node.type === "text") out += node.value;
    else if (node.type === "element") {
      if (skipped(node)) return;
      node.children.forEach(walk);
    } else if (node.type === "root") node.children.forEach(walk);
  };
  walk(tree);
  return out;
}

export interface StreamReveal {
  /** The rehype plugin: stable for the row. */
  plugin: Plugin<[], Root>;
  /** From now on new text fades; before it, text is shown as it stands. */
  arm(): void;
  /** When the newest step started (ms, performance.now()), or -Infinity. */
  lastStepAt(): number;
  /** Whether new text fades yet. */
  isArmed(): boolean;
  /**
   * When each of a fence's `count` lines first showed (ms), -Infinity for
   * the lines it held before the row armed. The fence is known by its code's
   * first LEDGER_KEY_CHARS characters; a shorter fence grows into its key.
   * A new line counts as a step, so the settle waits for its fade.
   */
  lineTimes(code: string, count: number): readonly number[];
  /** Which of a fence's lines are still fading in (`lineTimes` younger than
   *  REVEAL.fadeMs); none under reduced motion. */
  freshLines(code: string, count: number): boolean[];
}

/** The row's reveal while it streams, for the code blocks inside it; null
 *  once the row settled (AgentMarkdown). */
export const StreamRevealContext = createContext<StreamReveal | null>(null);

let rows = 0;

export function createStreamReveal(
  now: () => number = () => performance.now(),
  reduced: () => boolean = prefersReducedMotion,
): StreamReveal {
  const ledgers = new Map<string, Ledger>();
  const fences = new Map<string, number[]>();
  let armed = false;
  let last = -Infinity;

  const ledgerFor = (text: string): Ledger => {
    const key = text.slice(0, LEDGER_KEY_CHARS);
    let ledger = ledgers.get(key);
    if (!ledger) {
      // A block shorter than the key grows into a longer key.
      for (const [shortKey, short] of ledgers) {
        if (shortKey.length < LEDGER_KEY_CHARS && text.startsWith(short.text)) {
          ledgers.delete(shortKey);
          ledger = short;
          break;
        }
      }
    }
    if (!ledger || !text.startsWith(ledger.text)) ledger = { text: "", steps: [] };
    ledgers.set(key, ledger);
    return ledger;
  };

  const transform = (tree: Root): void => {
    const text = renderedText(tree);
    if (text === "") return;
    const ledger = ledgerFor(text);
    const t = now();
    if (text.length > ledger.text.length) {
      const at = armed ? t : -Infinity;
      ledger.steps.push({ from: ledger.text.length, to: text.length, at });
      if (at > last) last = at;
    }
    ledger.text = text;
    if (reduced()) return;
    wrapSteps(tree, ledger.steps, t);
  };

  // streamdown caches a processor under its plugins' function names, so the
  // row's plugin carries a name of its own, or every row would share the
  // first row's ledger.
  const plugin: Plugin<[], Root> = () => transform;
  Object.defineProperty(plugin, "name", { value: `streamReveal${++rows}` });
  const lineTimes = (code: string, count: number): number[] => {
    const key = code.slice(0, LEDGER_KEY_CHARS);
    let times = fences.get(key);
    if (!times) {
      for (const [shortKey, short] of fences) {
        if (shortKey.length < LEDGER_KEY_CHARS && code.startsWith(shortKey)) {
          fences.delete(shortKey);
          times = short;
          break;
        }
      }
    }
    times ??= [];
    fences.set(key, times);
    if (times.length < count) {
      const at = armed ? now() : -Infinity;
      while (times.length < count) times.push(at);
      if (at > last) last = at;
    }
    times.length = count;
    return times;
  };

  return {
    plugin,
    arm: () => {
      armed = true;
    },
    lastStepAt: () => last,
    isArmed: () => armed,
    lineTimes,
    freshLines: (code, count) => {
      const times = lineTimes(code, count);
      if (reduced()) return times.map(() => false);
      const t = now();
      return times.map((at) => t - at < REVEAL.fadeMs);
    },
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Splits every prose text node at the steps' bounds and wraps each piece
 *  in its step's span; a whitespace-only node (between block elements, in
 *  a table) stays bare. */
function wrapSteps(tree: Root, steps: Step[], t: number): void {
  let offset = 0;
  let step = 0;
  const visit = (parent: Root | Element): void => {
    const next: (RootContent | ElementContent)[] = [];
    for (const child of parent.children) {
      if (child.type === "element") {
        if (!skipped(child)) visit(child);
        else offset += renderedText(child).length;
        next.push(child);
        continue;
      }
      if (child.type !== "text") {
        next.push(child);
        continue;
      }
      const value = child.value;
      const start = offset;
      offset += value.length;
      if (value.trim() === "") {
        next.push(child);
        continue;
      }
      let at = start;
      while (at < offset) {
        while (step < steps.length - 1 && steps[step].to <= at) step++;
        const s = steps[step];
        const end = Math.min(offset, s.to > at ? s.to : offset);
        const young = t - s.at < REVEAL.fadeMs;
        next.push({
          type: "element",
          tagName: "span",
          properties: young ? { className: [STEP_CLASS], dataRevealStep: step } : { dataRevealStep: step },
          children: [{ type: "text", value: value.slice(at - start, end - start) }],
        });
        at = end;
      }
    }
    parent.children = next as typeof parent.children;
  };
  visit(tree);
}
