import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The page line guard (docs/DESIGN.md "Panels…" and "Loading and empty
 * states"): on Settings, a section's failure is `PageError` and a section
 * with nothing in it is `PageEmpty` (components/page.tsx), never a `<p>`
 * styled by hand, so every such line sits on one inset. A dialog body on
 * these pages is not a section; the counts below are those, and they only
 * shrink.
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
  file.startsWith("surfaces/settings/") ||
  /^chrome\/[^/]*Fields\.tsx$/.test(file) ||
  file === "chrome/OrchestrationRules.tsx" ||
  file === "chrome/ThreadDefaultsDialog.tsx" ||
  file === "chrome/MacBridgeRemember.tsx" ||
  file === "chrome/MacBridgeRunning.tsx" ||
  file === "chrome/rail/buildSettings.tsx" ||
  file === "surfaces/AppshotsSettings.tsx" ||
  file === "surfaces/ReviewSettings.tsx";

/** Dialog bodies, which another recipe owns (ConfirmDialog's ErrorLine). */
const DIALOG_LINES: Record<string, number> = {
  "surfaces/settings/Editor.tsx": 1,
  "surfaces/settings/General.tsx": 1,
  "surfaces/settings/hosts/MacBridgeHostDialog.tsx": 2,
};

const files = walk(ROOT)
  .map((path) => relative(ROOT, path))
  .filter(SCOPE)
  .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));

describe("the page line guard", () => {
  it("covers the settings pages", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("draws no section error or empty line by hand", () => {
    const counts: Record<string, number> = {};
    for (const { file, text } of files) {
      // A line of facts or a spinner's line is a flex row; an error or empty line is plain text.
      const n = [...text.matchAll(/<p\s+className=(["'`])([^"'`]*)\1/g)].filter(
        (m) => /\btext-(?:destructive|muted-foreground)\b/.test(m[2]) && !/\bflex\b/.test(m[2]),
      ).length;
      if (n) counts[file] = n;
    }
    expect(counts).toEqual(DIALOG_LINES);
  });
});
