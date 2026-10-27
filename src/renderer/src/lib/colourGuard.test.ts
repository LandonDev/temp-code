import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* Colours live in index.css's token declarations. These counted exceptions
 * are palette data or values required by an outside API; each names its use.
 * The counts only shrink. COLOUR_GUARD_PRINT=1 prints the current tally.
 * SVG assets, tests, test helpers and fixtures are not renderer source.
 */
const ROOT = resolve(__dirname, "..");
const ALLOWED: Record<string, { reason: string; count: number }> = {
  "chrome/ColorPicker.tsx": { reason: "The saturation field and hue strip are the colours being picked.", count: 9 },
  "lib/colorUtils.ts": { reason: "The colour converter needs a hex fallback when canvas cannot resolve a colour.", count: 2 },
  "lib/intellijTheme.ts": { reason: "IntelliJ syntax palettes are editor content.", count: 26 },
  "lib/tabGroups.ts": { reason: "Group colours are the named palette offered to the user.", count: 9 },
  "surfaces/TerminalView.tsx": { reason: "ANSI and terminal theme tables map terminal colour codes.", count: 45 },
  "surfaces/editorChrome.ts": { reason: "The highlight tables are CodeMirror's syntax palettes.", count: 18 },
  "surfaces/monaco/theme.ts": { reason: "Monaco requires hex palettes, including syntax and fallback colours.", count: 32 },
  "surfaces/settings/hosts/dialogs/PairDialog.tsx": { reason: "The QR encoder requires black and white for its image.", count: 2 },
  "surfaces/streamVeil.ts": { reason: "backdropOf compares the browser's computed transparent rgba value.", count: 1 },
};

// Match complete hex colours, never part of a word or an id (#ABCDE-12345).
// Underscores separate colours in Tailwind arbitrary values.
const COLOURS = /(?<![a-z\d#])#(?:[a-f\d]{8}|[a-f\d]{6}|[a-f\d]{4}|[a-f\d]{3})(?![a-z\d-])|(?<![a-z\d-])(?:rgba?|hsla?|oklch)\(/gi;
type Hit = { file: string; line: number; token: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["test", "tests", "fixtures", "__fixtures__", "__tests__"].includes(name)) walk(path, out);
    } else if (/\.(tsx?|css)$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

function sourceToScan(text: string, file: string): string {
  // Keep offsets for diagnostics; comments do not paint a colour.
  let source = text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, blank);
  if (file === "index.css") {
    // The top holds both the current tokens and the legacy token declarations.
    // Exempt only custom properties in those blocks, never their CSS rules.
    const end = source.indexOf("\nhtml,\nbody,\n#root {");
    const prefix = end < 0 ? "" : source.slice(0, end);
    const tokens = prefix.replace(/(?:^|\n)(?::root|html\.theme-light|@theme(?: inline)?)\s*\{[^{}]*\}/g,
      (block) => block.replace(/--[\w-]+\s*:[^;]+;/g, blank));
    source = tokens + source.slice(prefix.length);
  }
  return source;
}

function hits(text: string, file: string): Hit[] {
  const source = sourceToScan(text, file);
  return [...source.matchAll(COLOURS)]
    // A fragment identifies an SVG element or URL target, not a colour.
    .filter((match) => !match[0].startsWith("#") || !/\burl\(\s*["']?$|https?:\/\/[^\s"'`]*$/i.test(source.slice(0, match.index)))
    .map((match) => ({ file, line: source.slice(0, match.index).split("\n").length, token: match[0] }));
}

function scan() {
  const found: Record<string, Hit[]> = {};
  for (const path of walk(ROOT)) {
    const file = relative(ROOT, path);
    const colours = hits(readFileSync(path, "utf8"), file);
    if (colours.length) found[file] = colours;
  }
  return found;
}

const tree = scan();
if (process.env.COLOUR_GUARD_PRINT) console.log(JSON.stringify(Object.fromEntries(Object.entries(tree).map(([file, found]) => [file, found.length])), null, 2));
const where = (hit: Hit) => `${hit.file}:${hit.line} "${hit.token}"`;

describe("the colour guard", () => {
  it("finds no literal colour outside token declarations and the named palettes", () => {
    const problems: string[] = [];
    for (const [file, found] of Object.entries(tree)) {
      const allowed = ALLOWED[file];
      if (!allowed) problems.push(...found.map(where));
      else if (found.length > allowed.count)
        problems.push(`${file}: ${found.length} literal colours, ${allowed.count} allowed (${allowed.reason}): ${found.map(where).join(", ")}`);
    }
    expect(problems, "Use a colour token from index.css; palette exception counts only shrink.").toEqual([]);
  });

  it("lists only existing files and gives each exception a reason", () => {
    for (const [file, allowed] of Object.entries(ALLOWED)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(allowed.reason.length, file).toBeGreaterThan(0);
    }
  });

  it("catches every hex length and colour function, including Tailwind values", () => {
    for (const colour of ["#abc", "#abcd", "#ABCDEF", "#abcdef12", "rgb(1 2 3)", "rgba(0,0,0,.5)", "hsl(0 0% 0%)", "hsla(0,0%,0%,.5)", "oklch(0.5 0 0)", "drop-shadow-[0_1px_0_rgba(0,0,0,.5)]", "bg-[#fff]", "from-[#fff_10%]", "url(data:image/svg+xml;rgb(1 2 3))", 'url(data:image/svg+xml;fill="#fff")']) {
      expect(hits(colour, "example.tsx"), colour).toHaveLength(1);
    }
    expect(hits("#ab #abcde #abcdefg #abcdef123 #ABCDE-12345 var(--foreground) url(#abcdef) https://example.com/#abcdef", "example.tsx")).toEqual([]);
  });

  it("exempts only top-level token declarations, preserving line numbers", () => {
    const css = ':root { --foreground: #fff; color: #123; }\nhtml.theme-light { --foreground: #000; }\n@theme inline { --color-accent: #abc; }\nhtml,\nbody,\n#root { color: #456; }\n.late { --custom: #789; }';
    expect(hits(css, "index.css")).toEqual([
      { file: "index.css", line: 1, token: "#123" },
      { file: "index.css", line: 6, token: "#456" },
      { file: "index.css", line: 7, token: "#789" },
    ]);
    expect(hits(':root { --custom: #fff; }', "assets/components.css")).toHaveLength(1);
    expect(hits('/* #fff */\n// rgb(0 0 0)\nconst ink = "#123456";', "example.ts")).toEqual([{ file: "example.ts", line: 3, token: "#123456" }]);
  });
});
