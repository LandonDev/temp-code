import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The red button guard (CLAUDE.md "UI standard": a solid red button never
 * sits in a list row). A solid destructive `Button` is the red verb of a
 * dialog's footer and nothing else: a row's remove, stop or forget is a
 * ghost in muted ink that turns red on hover. Each `<Button` whose variant
 * names destructive must sit inside an open `<DialogFooter` or
 * `<AlertDialogFooter`. ConfirmDialog.tsx is where the footer's red verb is
 * defined.
 */

const ROOT = resolve(__dirname, "..");
const DEFINES_FOOTER = new Set(["chrome/ConfirmDialog.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name) && !/\.(test|fixtures|preview)\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** Whether `at` lies inside a footer element opened before it and not yet closed. */
function inFooter(text: string, at: number): boolean {
  const before = text.slice(0, at);
  for (const tag of ["DialogFooter", "AlertDialogFooter"]) {
    const open = Math.max(before.lastIndexOf(`<${tag}>`), before.lastIndexOf(`<${tag} `));
    if (open >= 0 && before.indexOf(`</${tag}>`, open) < 0) return true;
  }
  return false;
}

describe("the red button guard", () => {
  it("puts a solid red Button only in a dialog's footer, never in a row", () => {
    const off: string[] = [];
    for (const path of walk(ROOT)) {
      const file = relative(ROOT, path);
      if (DEFINES_FOOTER.has(file)) continue;
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/<Button\b[^>]*?variant=(?:"destructive"|\{[^}]*"destructive"[^}]*\})/g)) {
        if (!inFooter(text, m.index ?? 0)) off.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(off).toEqual([]);
  });

  it("catches a red row button", () => {
    const row = `<Row title="Call"><Button variant="destructive" size="xs">Stop</Button></Row>`;
    expect(inFooter(row, row.indexOf("<Button"))).toBe(false);
    const footer = `<DialogFooter className="x"><Button variant="destructive">Delete</Button></DialogFooter>`;
    expect(inFooter(footer, footer.indexOf("<Button"))).toBe(true);
  });
});
