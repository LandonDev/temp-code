import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The motion guard. Durations and curves live in two places only: lib/ease.ts
 * and the token layer at the top of index.css (through the `@theme inline`
 * block). Everywhere else in src/renderer a literal timing is a failure,
 * unless the site is listed below with the area that owns it. The lists only
 * shrink: an area that moves its file onto the tokens deletes its row (or
 * lowers its count); nobody adds one. A26 empties them.
 *
 * MOTION_GUARD_PRINT=1 prints the tree's current tally as the lists' source.
 */

const ROOT = resolve(__dirname, "..");

/** .ts/.tsx files allowed literal timings: the owning area and how many. */
const ALLOWED: Record<string, { owner: string; count: number }> = {
  "aliax/components/evilcharts/charts/recharts-pie-chart.tsx": { owner: "A4", count: 1 },
  "aliax/components/evilcharts/charts/recharts-radial-chart.tsx": { owner: "A4", count: 2 },
  "aliax/components/evilcharts/charts/recharts-sankey-chart.tsx": { owner: "A4", count: 6 },
  "aliax/components/motion/loader.tsx": { owner: "A4", count: 2 },
  "aliax/components/ui/dialog.tsx": { owner: "A4", count: 1 },
  "aliax/components/ui/dropdown-menu.tsx": { owner: "A4", count: 2 },
  "aliax/components/ui/progress.tsx": { owner: "A4", count: 1 },
  "aliax/lib/ease.ts": { owner: "A4", count: 5 },
  "aliax/views/accounts.tsx": { owner: "A4", count: 1 },
  "chrome/AttachmentChip.tsx": { owner: "A10", count: 1 },
  "chrome/ComposerInput.tsx": { owner: "A10", count: 3 },
  "chrome/ModelSettings.tsx": { owner: "A10", count: 1 },
  "components/ui/plan-card.tsx": { owner: "shell", count: 4 },
  "components/ui/question-card.tsx": { owner: "shell", count: 5 },
  "components/ui/spinner.tsx": { owner: "shell", count: 1 },
  "lib/composerHeight.ts": { owner: "A10", count: 2 },
  "surfaces/TranscriptMinimap.tsx": { owner: "A7", count: 1 },
  "surfaces/threads/spinners.tsx": { owner: "A21", count: 1 },
};

/** CSS rules allowed literal timings, as "<file> <selector>": the owning area. */
const CSS_ALLOWED: Record<string, string> = {
  "assets/components.css @utility shimmer": "shell",
  "assets/components.css .t-toggle-thumb": "shell",
  'assets/components.css .t-check[aria-checked="true"] svg path': "shell",
  "assets/components.css .task-donut": "shell",
  "assets/components.css .task-strike": "shell",
  'assets/components.css .task-label[data-state="done"] .task-strike': "shell",
  "index.css @theme": "shell",
  "index.css :root": "shell",
  "index.css .z-fade-in, .z-fade-quick": "A7",
  "index.css .monaco-editor .model-change-line": "A23",
  "index.css .monaco-editor .reveal-flash-line": "A23",
};

/** Every @keyframes in a stylesheet under src/renderer/src, and what it serves. */
const KEYFRAMES: Record<string, string> = {
  "text-shimmer": "components/ui/text-shimmer.tsx",
  "streaming-word-fade": "components/ui/streaming-text.tsx",
  "status-breathe": "components/ui/status.tsx",
  "mascot-rest": "chrome/ComposerRunner.tsx",
  "mascot-talk": "chrome/ComposerRunner.tsx",
  "popover-open": "chrome/Popover.tsx",
  "z-matrix": "surfaces/threads/spinners.tsx",
  "z-fade-quick": "surfaces/AgentTranscript.tsx",
  "reveal-flash": "surfaces/monaco/MonacoPane.tsx",
  "bubble-send-in": "surfaces/transcript/UserMessage.tsx",
  "bubble-send-flip": "surfaces/transcript/UserMessage.tsx",
};

const TAILWIND = [
  /duration-\[/g,
  /ease-\[/g,
  /delay-\[/g,
  /animate-\[/g,
  /(?<![\w-])duration-(?!0\b)\d+\b/g,
  /(?<![\w-])delay-\d+\b/g,
  /(?<![\w-])ease-(?:linear|in|out|in-out)(?![\w-])/g,
];
// A zero duration is "instant", not a timing, and passes everywhere.
const SCRIPT = [/duration:\s*(?!0\b)\d/g, /ease:\s*\[/g, /type:\s*["']spring["']/g, /easing:\s*["']/g];
const STYLE = [
  /\d+(?:\.\d+)?m?s\s+(?:linear|ease|cubic-bezier|steps|var\(--ease)/g,
  /cubic-bezier\(/g,
  /(?:transition|animation)-(?:duration|delay):\s*(?!0(?:m?s)?\b)\d/g,
];

const INSTEAD =
  "use the tokens: --dur-fast/base/slow/drawer and --ease-out/drawer/exit in CSS (duration-(--dur-fast) ease-(--ease-out) in a class), DUR.* with EASE_OUT/EASE_DRAWER or SPRING_LAYOUT from lib/ease in Motion";

type Hit = { file: string; line: number; token: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

function hits(text: string, patterns: RegExp[], file: string, offset = 0): Hit[] {
  const found: Hit[] = [];
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) found.push({ file, line: lineOf(text, match.index) + offset, token: match[0] });
  return found;
}

/** A stylesheet's leaf rules with their selector (nested selectors joined)
 *  and declarations; @keyframes bodies are skipped, top-level @keyframes
 *  names are collected (a redefinition inside @media is a variant). */
function parseCss(text: string) {
  const rules: { selector: string; body: string; line: number }[] = [];
  const keyframes: string[] = [];
  const stack: { selector: string; start: number; keyframes: boolean }[] = [];
  let mark = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i + 2) + 1;
      mark = i + 1;
      continue;
    }
    if (ch === "{") {
      const selector = text.slice(mark, i).replace(/\s+/g, " ").trim();
      const inKeyframes = stack.some((s) => s.keyframes);
      const name = /^@keyframes\s+([\w-]+)/.exec(selector)?.[1];
      if (name && !stack.some((s) => s.selector.startsWith("@media"))) keyframes.push(name);
      stack.push({ selector: inKeyframes ? "" : selector, start: i + 1, keyframes: inKeyframes || !!name });
      mark = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top && !top.keyframes) {
        const body = text.slice(top.start, i).replace(/[^;{}]*\{[^}]*\}/g, "");
        const selector = [...stack.map((s) => s.selector).filter((s) => !s.startsWith("@")), top.selector].join(" ");
        rules.push({ selector, body, line: lineOf(text, top.start) });
      }
      mark = i + 1;
    } else if (ch === ";" && stack.length === 0) mark = i + 1;
  }
  return { rules, keyframes };
}

/** index.css up to the end of its `@theme inline` block is the token layer. */
function tokenLayerEnd(text: string): number {
  const start = text.indexOf("@theme inline {");
  if (start < 0) return 0;
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

function scan() {
  const scripts: Record<string, Hit[]> = {};
  const css: Record<string, Hit[]> = {};
  const keyframes: { name: string; file: string }[] = [];
  for (const path of walk(ROOT)) {
    const file = relative(ROOT, path);
    const text = readFileSync(path, "utf8");
    if (file.endsWith(".css")) {
      const end = file === "index.css" ? tokenLayerEnd(text) : 0;
      const skippedLines = end ? lineOf(text, end) - 1 : 0;
      const parsed = parseCss(text.slice(end));
      for (const name of parsed.keyframes) keyframes.push({ name, file });
      for (const rule of parsed.rules) {
        const found = hits(rule.body, [...STYLE, ...TAILWIND], file, rule.line - 1 + skippedLines);
        if (found.length) (css[`${file} ${rule.selector}`] ??= []).push(...found);
      }
    } else if (file !== "lib/ease.ts") {
      const found = hits(text, [...TAILWIND, ...SCRIPT, ...STYLE], file);
      if (found.length) scripts[file] = found;
    }
  }
  return { scripts, css, keyframes };
}

const tree = scan();

if (process.env.MOTION_GUARD_PRINT) {
  console.log(
    JSON.stringify(
      {
        scripts: Object.fromEntries(Object.entries(tree.scripts).map(([f, h]) => [f, h.length])),
        css: Object.keys(tree.css),
        keyframes: tree.keyframes,
      },
      null,
      1,
    ),
  );
}

const where = (h: Hit) => `${h.file}:${h.line} "${h.token}"`;

describe("the motion guard", () => {
  it("finds no literal timing outside lib/ease.ts, the token layer and the listed sites", () => {
    const problems: string[] = [];
    for (const [file, found] of Object.entries(tree.scripts)) {
      const allowed = ALLOWED[file];
      if (!allowed) problems.push(...found.map(where));
      else if (found.length > allowed.count)
        problems.push(`${file}: ${found.length} literal timings, ${allowed.count} allowed (${allowed.owner}): ${found.map(where).join(", ")}`);
    }
    for (const [key, found] of Object.entries(tree.css)) if (!CSS_ALLOWED[key]) problems.push(...found.map(where));
    expect(problems, `literal motion values; ${INSTEAD}`).toEqual([]);
  });

  it("names every @keyframes once, by the component it serves", () => {
    const names = tree.keyframes.map((k) => k.name);
    expect(names.filter((name, i) => names.indexOf(name) !== i), "defined twice").toEqual([]);
    expect(new Set(names)).toEqual(new Set(Object.keys(KEYFRAMES)));
  });

  it("points each keyframes entry at a file that exists", () => {
    for (const [name, servedBy] of Object.entries(KEYFRAMES)) expect(existsSync(join(ROOT, servedBy)), name).toBe(true);
  });
});
