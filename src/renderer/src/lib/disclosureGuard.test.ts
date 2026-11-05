import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* One disclosure chevron (DESIGN.md "Motion values"): a fold's chevron is
   `ChevronRight` with `DISCLOSURE_CHEVRON` (components/ui/disclosure.ts),
   turning `rotate-90` with its fold. Nothing beside it times its own turn
   or colour, nothing turns it 180°, and no chevron rotates without it. A
   menu trigger's chevron is a still `ChevronDown`. The allow-list is empty
   and only shrinks. */
const ALLOWED: string[] = [];

const root = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** Every `<ChevronX …>` opening tag in a file, whole: braces and quotes are
 *  skipped, so an `=>` or a `>` inside an expression never ends the tag. */
function chevronTags(source: string): string[] {
  const tags: string[] = [];
  const open = /<Chevron(?:Right|Down|Up|Left)\b/g;
  for (let m = open.exec(source); m; m = open.exec(source)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

/** What is wrong with one chevron tag, or null. */
function chevronProblem(tag: string): string | null {
  const disclosure = tag.includes("DISCLOSURE_CHEVRON");
  if (/\bduration-|\btransition-/.test(tag)) return "times its own motion";
  if (/\brotate-180\b/.test(tag)) return "turns 180°";
  if (disclosure && !tag.startsWith("<ChevronRight")) return "a disclosure is a ChevronRight";
  if (!disclosure && /\brotate-/.test(tag)) return "rotates without DISCLOSURE_CHEVRON";
  return null;
}

describe("the disclosure chevron", () => {
  it("is one recipe: no chevron in the renderer times its own turn, turns 180° or rotates by hand", () => {
    const found: string[] = [];
    for (const path of walk(root)) {
      for (const tag of chevronTags(readFileSync(path, "utf8"))) {
        const problem = chevronProblem(tag);
        if (problem) found.push(`${relative(root, path)}: ${problem}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(found).toEqual(ALLOWED);
  });

  it("refuses each hand-made form", () => {
    expect(chevronProblem('<ChevronRight className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />')).toBeNull();
    expect(chevronProblem('<ChevronDown className="size-3 shrink-0" />')).toBeNull();
    expect(chevronProblem('<ChevronRight className={cn("transition-[rotate] duration-(--dur-fast)", open && "rotate-90")} />')).toBe("times its own motion");
    expect(chevronProblem('<ChevronDown className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-180")} />')).toBe("turns 180°");
    expect(chevronProblem('<ChevronDown className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />')).toBe("a disclosure is a ChevronRight");
    expect(chevronProblem('<ChevronRight className={open ? "rotate-90" : ""} />')).toBe("rotates without DISCLOSURE_CHEVRON");
  });

  it("reads a tag whole past an arrow function", () => {
    expect(chevronTags('<ChevronRight onClick={() => go(a > b)} className="x" /> <p>')).toEqual(['<ChevronRight onClick={() => go(a > b)} className="x" />']);
  });

  it("leaves no stylesheet turning a chevron of its own", () => {
    const css = readFileSync(join(root, "assets/components.css"), "utf8");
    expect(css).not.toMatch(/chevron/i);
  });

  it("is a transform turn on --dur-base", async () => {
    const { DISCLOSURE_CHEVRON } = await import("../components/ui/disclosure");
    expect(DISCLOSURE_CHEVRON).toContain("transition-transform");
    expect(DISCLOSURE_CHEVRON).toContain("duration-(--dur-base)");
    expect(DISCLOSURE_CHEVRON).toContain("motion-reduce:transition-none");
  });
});
