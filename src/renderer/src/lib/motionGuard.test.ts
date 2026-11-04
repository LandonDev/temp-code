import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The motion guard. Durations and curves live in two places only: lib/ease.ts
 * and the token layer at the top of index.css (through the `@theme inline`
 * block). Everywhere else in src/renderer a literal timing is a failure,
 * unless it defines a token below or a third-party class needs the literal.
 * Each kept entry states why; application sites use the shared tokens.
 *
 * MOTION_GUARD_PRINT=1 prints the tree's current tally as the lists' source.
 */

const ROOT = resolve(__dirname, "..");

/** .ts/.tsx files allowed literal timings: the owning area and how many. */
const ALLOWED: Record<string, { owner: string; count: number }> = {};

/** Only token definitions may keep literal timings. */
const CSS_ALLOWED: Record<string, string> = {};

/** Every @keyframes in a stylesheet under src/renderer/src, and what it serves. */
const KEYFRAMES: Record<string, string> = {
  "stream-step-in": "lib/streamReveal.ts",
  "status-breathe": "components/ui/status.tsx",
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
const SCRIPT = [/duration:\s*(?!0(?![.\d]))\d/g, /ease:\s*\[/g, /type:\s*["']spring["']/g, /easing:\s*["']/g];
const STYLE = [
  /\d+(?:\.\d+)?m?s\s+(?:linear|ease|cubic-bezier|steps|var\(--ease)/g,
  /cubic-bezier\(/g,
  /(?:transition|animation)-(?:duration|delay):\s*(?!0(?:m?s)?(?![.\w]))\d/g,
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

  it("never writes a keyframes name as a class that no rule defines: it would animate nothing", () => {
    // `z-fade-quick` is a keyframes name; the class that runs it is `.z-fade-in`.
    // A class may share its keyframes' name only where a stylesheet defines that class.
    const css = walk(ROOT).filter((path) => path.endsWith(".css")).map((path) => readFileSync(path, "utf8")).join("\n");
    const misused: string[] = [];
    for (const file of walk(ROOT).filter((path) => path.endsWith(".tsx"))) {
      const text = readFileSync(file, "utf8");
      for (const name of Object.keys(KEYFRAMES).filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css))) {
        if (new RegExp(`(["'\`\\s])${name}(?=["'\`\\s])`).test(text)) misused.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
    expect(misused).toEqual([]);
  });

  it("opens and closes every popup on transitions, never on enter and exit keyframes", () => {
    // A keyframe restarts from its first frame, so a popup closed mid-open jumped;
    // a transition turns back from where it is.
    const keyframed: string[] = [];
    for (const file of walk(ROOT).filter((path) => path.endsWith(".tsx"))) {
      if (/data-open:animate-in|data-closed:animate-out/.test(readFileSync(file, "utf8"))) keyframed.push(relative(ROOT, file));
    }
    expect(keyframed).toEqual([]);
  });

  it("points each keyframes entry at a file that exists", () => {
    for (const [name, servedBy] of Object.entries(KEYFRAMES)) expect(existsSync(join(ROOT, servedBy)), name).toBe(true);
  });
});

describe("hover reveals under reduced motion", () => {
  it("keep their fade: every class string that waits --delay-hover narrows its transition to opacity", () => {
    const off: string[] = [];
    for (const file of walk(ROOT).filter((path) => path.endsWith(".tsx"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/["'`][^"'`]*delay-\(--delay-hover\)[^"'`]*["'`]/g)) {
        if (!m[0].includes("motion-reduce:transition-opacity")) off.push(`${relative(ROOT, file)}:${lineOf(text, m.index!)}`);
      }
    }
    expect(off).toEqual([]);
  });

  it("the task share keeps its fade too; only its slide goes", () => {
    const css = readFileSync(join(ROOT, "assets/components.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.task-share \{\s*transition: opacity var\(--dur-fast\) var\(--ease-out\);/);
  });
});
