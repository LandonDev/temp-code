import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx$/.test(name) && !/\.(test|fixtures)\.tsx$/.test(name) ? [path] : [];
  });
}

/** Check JSX children, including children passed through a primitive's render slot. */
function bareSpinners(text: string): number[] {
  const source = ts.createSourceFile("view.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: number[] = [];
  const tag = (node: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(source);
  const button = (node: ts.Node): boolean => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (["Button", "AlertDialogAction"].includes(tag(node))) return true;
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      return opening.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "render" && !!attr.initializer && button(attr.initializer));
    }
    return ts.isJsxExpression(node) && !!node.expression && button(node.expression);
  };
  const scan = (node: ts.Node) => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && tag(node) === "BusyLabel") return;
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && tag(node) === "Spinner") hits.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    ts.forEachChild(node, scan);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && button(node)) node.children.forEach(scan);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("the busy button guard", () => {
  it("catches a spinner in a button, through an expression or a render slot", () => {
    for (const jsx of [
      '<Button>{pending ? <Spinner /> : null}Save</Button>',
      '<Button><Spinner></Spinner>Save</Button>',
      '<Button><span><Spinner /></span>Save</Button>',
      '<TooltipTrigger render={<Button />}><Spinner />Save</TooltipTrigger>',
      '<AlertDialogAction><Spinner />Delete</AlertDialogAction>',
    ]) expect(bareSpinners(jsx)).toEqual([1]);
    expect(bareSpinners('<Button><BusyLabel busy={pending} label="Save" /></Button>')).toEqual([]);
    expect(bareSpinners('<div><Spinner />Loading</div>')).toEqual([]);
  });

  it("puts every button's spinner inside BusyLabel so its width stays put", () => {
    const hits = files(ROOT).flatMap((path) => bareSpinners(readFileSync(path, "utf8")).map((line) => `${relative(ROOT, path)}:${line}`));
    expect(hits).toEqual([]);
  });
});
