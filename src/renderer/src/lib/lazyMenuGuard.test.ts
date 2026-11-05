import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* Every right-click menu mounts its body on the first right-click
   (`RowsContextMenu lazyMount`, chrome/menuRows.tsx): a body mounted at rest
   re-renders Base UI's menu tree with every render of the list it wraps, and
   a workspace switch renders every list (the rail, the column, the strip,
   the board, the file tree) at once. Fixtures and tests are left alone. */
const root = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name) && !/\.(test|fixtures|sketch)\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** Every `<RowsContextMenu …>` opening tag, whole: braces and quotes skipped, so a `>` inside an expression never ends it. */
function menuTags(source: string): string[] {
  const tags: string[] = [];
  const open = /<RowsContextMenu\b/g;
  for (let m = open.exec(source); m; m = open.exec(source)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const ch = source[i]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

describe("right-click menus mount lazily", () => {
  it("every RowsContextMenu in the renderer passes lazyMount", () => {
    const eager: string[] = [];
    let seen = 0;
    for (const file of walk(root)) {
      for (const tag of menuTags(readFileSync(file, "utf8"))) {
        seen++;
        if (!/\blazyMount\b/.test(tag)) eager.push(`${relative(root, file)}: ${tag.slice(0, 80)}`);
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(eager).toEqual([]);
  });
});
