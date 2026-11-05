import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* One hover reveal (docs/DESIGN.md "Hover reveal", components/ui/reveal.ts):
   a control shown on a group's hover waits `--delay-hover`, so a pointer
   crossing a list flashes nothing, and a mouse click never holds it, so
   focus-within is never what shows (or yields to) a reveal: keyboard focus
   is `focus-visible`. The guard reads every class string in the renderer.
   The allow-list only shrinks; each entry names the landing that redoes it
   (L5: the rail and the workspace column).
   A count may fall below its entry: a sibling slice fixing one leaves it. */
const ALLOWED: Record<string, { landing: string; count: number }> = {
  "chrome/RailRow.tsx": { landing: "L5", count: 2 },
  "chrome/WorkspaceSessions.tsx": { landing: "L5", count: 3 },
};

const root = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Every quoted or template string in a source file. */
function strings(source: string): string[] {
  return source.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? [];
}

/** How many of a source's class strings break the reveal rule. */
function revealViolations(source: string): number {
  let n = 0;
  for (const text of strings(source)) {
    if (/\b(?:group|peer)-hover(?:\/[\w-]+)?:opacity-100\b/.test(text) && !text.includes("delay-(--delay-hover)")) n++;
    n += (text.match(/\bfocus-within(?:\/[\w-]+)?:opacity-/g) ?? []).length;
  }
  return n;
}

describe("the hover reveal", () => {
  it("refuses a hover reveal without --delay-hover and any focus-within opacity", () => {
    expect(revealViolations('"opacity-0 group-hover/row:opacity-100"')).toBe(1);
    expect(revealViolations('"opacity-0 group-hover:opacity-100 group-hover:delay-(--delay-hover)"')).toBe(0);
    expect(revealViolations('"opacity-0 group-hover/q:opacity-100 group-hover/q:delay-(--delay-hover) focus-within:opacity-100"')).toBe(1);
    expect(revealViolations('`group-focus-within/row:opacity-0`')).toBe(1);
    expect(revealViolations('"has-focus-visible:opacity-100 group-has-focus-visible/row:opacity-100"')).toBe(0);
  });

  it("holds every renderer file to it, past the allow-list", () => {
    const over: Record<string, number> = {};
    for (const path of walk(root)) {
      const name = relative(root, path);
      const found = revealViolations(readFileSync(path, "utf8"));
      if (found > (ALLOWED[name]?.count ?? 0)) over[name] = found;
    }
    expect(over).toEqual({});
  });
});
