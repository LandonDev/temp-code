import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The facts guard: on Settings a line of facts is `Facts`
 * (surfaces/settings/hosts/Facts.tsx), never a wrapping span of spans set
 * apart by space alone (`flex-wrap gap-x-2`). Copies drift: there were four.
 */

const ROOT = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name) && !/\.(test|fixtures|preview)\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

const SCOPE = (file: string): boolean =>
  file.startsWith("surfaces/settings/") || /^chrome\/(OrchestrationRules|PlanSettingsFields|ThreadDefaultsDialog|TurnPassFields|ReviewFields|MacBridge\w+)\.tsx$/.test(file);

describe("the facts guard", () => {
  it("draws no hand-built facts line on Settings", () => {
    const off = walk(ROOT)
      .map((path) => relative(ROOT, path))
      .filter(SCOPE)
      .filter((file) => /flex-wrap[^"'`]*gap-x-2|gap-x-2[^"'`]*flex-wrap/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(off).toEqual([]);
  });
});
