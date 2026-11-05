import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : files(path);
    return /\.tsx?$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name) ? [path] : [];
  });
}

function unboundedScrollers(text: string): number[] {
  const source = ts.createSourceFile("view.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const classes = node.text.split(/\s+/);
      if (classes.includes("overflow-y-auto") && !classes.some((c) => c === "overflow-x-hidden" || c === "overflow-x-auto")) {
        hits.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("the vertical scroller guard", () => {
  it("checks each class string, including recipes and templates, rather than another element's classes", () => {
    expect(unboundedScrollers('<><div className="overflow-y-auto" /><div className="overflow-x-hidden" /></>')).toEqual([1]);
    expect(unboundedScrollers('const recipe = "min-h-0 overflow-y-auto"')).toEqual([1]);
    expect(unboundedScrollers('const recipe = `overflow-y-auto ${extra}`')).toEqual([1]);
    expect(unboundedScrollers('<div className="overflow-y-auto overflow-x-hidden" />')).toEqual([]);
    expect(unboundedScrollers('<pre className="overflow-x-auto overflow-y-auto" />')).toEqual([]);
  });

  it("gives every vertical scroller an explicit horizontal policy", () => {
    const hits = files(ROOT).flatMap((path) => unboundedScrollers(readFileSync(path, "utf8")).map((line) => `${relative(ROOT, path)}:${line}`));
    expect(hits).toEqual([]);
  });
});
