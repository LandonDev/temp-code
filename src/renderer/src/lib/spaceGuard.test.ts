import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/* No visible text separates two facts with a run of spaces (docs/DESIGN.md
 * "Typography and text hierarchy"): drawn, a word and its detail are two
 * spans; written as one string, "Word: Detail". The guard reads every string
 * literal, template text and JSX text in the renderer (never a comment) and
 * fails on two or more spaces between two non-space characters. These counted
 * exceptions are code, console output or column padding; each names its use.
 * The counts only shrink. SPACE_GUARD_PRINT=1 prints the current tally.
 * Tests, fixtures, previews and sketches are not renderer source.
 */
const ROOT = resolve(__dirname, "..");
const ALLOWED: Record<string, { reason: string; count: number }> = {
  "surfaces/threads/master/boardFixture.ts": { reason: "The queued row's legacy activity, as an older host writes it beside statusDetail.", count: 1 },
};

const RUN = /\S {2,}\S/;
type Hit = { file: string; line: number; text: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["test", "tests", "fixtures", "__fixtures__", "__tests__", "Generated"].includes(name)) walk(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.(test|dom\.test|fixtures|preview|sketch)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Every literal, template piece and JSX text holding a run of spaces between two words. */
export function hits(text: string, file: string): Hit[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Hit[] = [];
  const check = (node: ts.Node, value: string) => {
    if (RUN.test(value)) found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: value.trim().slice(0, 60) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    // An interpolation is a word at the piece's edge: `${word}  ${detail}`.
    else if (ts.isTemplateHead(node)) check(node, `${node.text}x`);
    else if (ts.isTemplateMiddle(node)) check(node, `x${node.text}x`);
    else if (ts.isTemplateTail(node)) check(node, `x${node.text}`);
    else if (ts.isJsxText(node)) check(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function scan() {
  const found: Record<string, Hit[]> = {};
  for (const path of walk(ROOT)) {
    const file = relative(ROOT, path);
    const runs = hits(readFileSync(path, "utf8"), file);
    if (runs.length) found[file] = runs;
  }
  return found;
}

const tree = scan();
if (process.env.SPACE_GUARD_PRINT) console.log(JSON.stringify(Object.fromEntries(Object.entries(tree).map(([file, found]) => [file, found.length])), null, 2));
const where = (hit: Hit) => `${hit.file}:${hit.line} "${hit.text}"`;

describe("the space guard", () => {
  it("finds no run of spaces between two words in renderer text", () => {
    const problems: string[] = [];
    for (const [file, found] of Object.entries(tree)) {
      const allowed = ALLOWED[file];
      if (!allowed) problems.push(...found.map(where));
      else if (found.length > allowed.count)
        problems.push(`${file}: ${found.length} runs of spaces, ${allowed.count} allowed (${allowed.reason}): ${found.map(where).join(", ")}`);
    }
    expect(problems, "Draw a word and its detail as two spans, or write \"Word: Detail\"; exception counts only shrink.").toEqual([]);
  });

  it("lists only existing files and gives each exception a reason", () => {
    for (const [file, allowed] of Object.entries(ALLOWED)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(allowed.reason.length, file).toBeGreaterThan(0);
    }
  });

  it("reads literals, templates and JSX text, never comments or indentation", () => {
    expect(hits('const a = "Queued  waiting";', "a.ts")).toHaveLength(1);
    expect(hits("const a = `${w}  ${d}`;", "a.ts")).toHaveLength(1);
    expect(hits("const a = <span>Release  1.0</span>;", "a.tsx")).toHaveLength(1);
    expect(hits('// two  spaces\n/* and  more */\nconst a = "one space";', "a.ts")).toEqual([]);
    expect(hits("const a = (\n  <span>\n    Release\n  </span>\n);", "a.tsx")).toEqual([]);
    expect(hits('const a = "  padded ";', "a.ts")).toEqual([]);
  });
});
