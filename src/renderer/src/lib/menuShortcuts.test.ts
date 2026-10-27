import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { KEYBINDING_GROUPS } from "./settings";

/**
 * A key cap in a menu row or a `Tip` names a binding the app handles: every
 * hint comes from `shortcutFor(group, name)` over KEYBINDING_GROUPS, never a
 * hand-typed string. The window's menu bar is the one exception: its
 * accelerators come from the menu table itself (src/shared/menuTree.ts).
 */

const ROOT = join(__dirname, "..");

/** Files whose hand-typed hints are not yet on `shortcutFor`, with who moves them. */
const NOT_YET: readonly string[] = [
  // A12 slice 3: the file tree's context menu.
  "chrome/FileTree.tsx",
  // A12 slice 4: the group menu loses its ⌘T and ⌘W.
  "chrome/TabGroupMenu.tsx",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// components/ui is the shell: its `shortcut` keys are class names.
const files = sources(ROOT).filter((path) => !relative(ROOT, path).startsWith("components/ui/")).map((path) => ({ file: relative(ROOT, path), text: readFileSync(path, "utf8") }));

describe("menu and tip shortcuts", () => {
  it("every shortcutFor names a binding", () => {
    const known = new Set(KEYBINDING_GROUPS.flatMap((g) => g.bindings.map((b) => `${g.title} › ${b.name}`)));
    const missing: string[] = [];
    for (const { file, text } of files) {
      for (const match of text.matchAll(/shortcutFor\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)) {
        const key = `${match[1]} › ${match[2]}`;
        if (!known.has(key)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("no hand-typed shortcut on a row or a tip", () => {
    const typed = files
      .filter(({ file }) => !NOT_YET.includes(file))
      .flatMap(({ file, text }) => [...text.matchAll(/\bshortcut(?::|=\{?)\s*[`"']/g)].map(() => file));
    expect([...new Set(typed)]).toEqual([]);
  });

  it("the not-yet list names only files that still type one", () => {
    const stale = NOT_YET.filter((file) => !/\bshortcut(?::|=\{?)\s*[`"']/.test(files.find((f) => f.file === file)?.text ?? ""));
    expect(stale).toEqual([]);
  });
});
