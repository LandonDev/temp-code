import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * No `title=` on a DOM element: a label on hover is a `Tooltip` (`Tip`,
 * `TruncateTip` in components/tip.tsx), which opens on the app's delay,
 * in its colours, and moves between neighbours. An `<iframe>`'s title is
 * its accessible name and stays. A component's own `title` prop is not a
 * DOM attribute and is not counted.
 */

const ROOT = __dirname;

/** Files not yet swept, each with who sweeps it. Empty when the sweep is done. */
const NOT_YET: readonly string[] = [
  // A12 slice 4: the pickers and the group menu.
  "chrome/AccountsPopover.tsx",
  "chrome/BranchPicker.tsx",
  "chrome/CwdPicker.tsx",
  "chrome/TabGroupMenu.tsx",
  // A12 slice 6: the title= sweep.
  "chrome/HostGlyph.tsx",
  "chrome/TitleBar.tsx",
  "chrome/WindowControls.tsx",
  "surfaces/CopyMessageButton.tsx",
  "surfaces/InboxComments.tsx",
  "surfaces/InboxPrDiff.tsx",
  "surfaces/NotesView.tsx",
  "surfaces/threadChat.tsx",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") && !/\.(test|dom\.test|fixtures)\.tsx$/.test(entry.name) ? [path] : [];
  });
}

function domTitles(path: string): number[] {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "title") {
      const tag = node.parent.parent;
      if (ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) {
        const name = tag.tagName.getText(file);
        if (/^[a-z]/.test(name) && name !== "iframe") lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe("title= on DOM elements", () => {
  const found = new Map<string, number[]>();
  for (const path of sources(ROOT)) {
    const lines = domTitles(path);
    if (lines.length) found.set(relative(ROOT, path), lines);
  }

  it("none outside the files not yet swept", () => {
    const stray = [...found].filter(([file]) => !NOT_YET.includes(file)).map(([file, lines]) => `${file}:${lines.join(",")}`);
    expect(stray).toEqual([]);
  });

  it("the not-yet list names only files that still have one", () => {
    expect(NOT_YET.filter((file) => !found.has(file))).toEqual([]);
  });
});
