import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* One hover reveal (docs/DESIGN.md "Hover reveal", components/ui/reveal.ts):
   a control shown on a group's hover waits `--delay-hover`, so a pointer
   crossing a list flashes nothing, and a mouse click never holds it, so
   focus-within is never what shows (or yields to) a reveal: keyboard focus
   is `focus-visible`. A hover never changes what takes room: no display or
   visibility toggle on a group's or a peer's hover (a name beside it would
   reflow), and every opacity it sets, a reveal's or a yield's, waits the
   same delay. The guard reads every class string in the renderer.
   The allow-list only shrinks; each entry names the landing that redoes it
   It is empty: every reveal in the renderer keeps the rule.
   A count may fall below its entry: a sibling slice fixing one leaves it. */
const ALLOWED: Record<string, { landing: string; count: number }> = {
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
    if (/\b(?:group|peer)-hover(?:\/[\w-]+)?:opacity-\d+\b/.test(text) && !text.includes("delay-(--delay-hover)")) n++;
    n += (text.match(/\b(?:group|peer)-hover(?:\/[\w-]+)?:(?:hidden|flex|inline-flex|block|inline-block|inline|grid|inline-grid|contents|visible|invisible)(?![\w-])/g) ?? []).length;
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

  it("refuses a display or visibility toggle on hover, and any hover opacity without the wait", () => {
    expect(revealViolations('"hidden group-hover/row:inline-flex group-hover/row:delay-(--delay-hover)"')).toBe(1);
    expect(revealViolations('"group-hover:hidden"')).toBe(1);
    expect(revealViolations('"invisible group-hover:visible"')).toBe(1);
    expect(revealViolations('"peer-hover:block"')).toBe(1);
    expect(revealViolations('"group-hover/item:opacity-90"')).toBe(1);
    expect(revealViolations('"group-hover/row:opacity-0"')).toBe(1);
    expect(revealViolations('"group-hover/row:opacity-0 group-hover/row:delay-(--delay-hover)"')).toBe(0);
    // A hover's fill or colour is not a reveal.
    expect(revealViolations('"group-hover:bg-muted group-hover:text-foreground"')).toBe(0);
    expect(revealViolations('"group-hover/row:flex-1"')).toBe(0);
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
