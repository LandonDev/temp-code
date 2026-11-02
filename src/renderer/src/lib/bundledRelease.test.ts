import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import release from "../../../../release.json";
import { BUNDLED_RELEASE } from "./bundledRelease";

describe("the bundled release", () => {
  it("carries the running build's version, date and notes", () => {
    expect(BUNDLED_RELEASE.version).toBe(`1.0.${release.n}`);
    expect(BUNDLED_RELEASE.notes).toBe(release.notes);
    expect(BUNDLED_RELEASE.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("stays out of the first paint: the tab title module and App never import release.json", () => {
    // The notes are every commit subject since the last release; in the index
    // chunk they grew the first paint by each release's length.
    for (const file of ["releaseNotes.ts", "../App.tsx"]) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      expect(source, file).not.toMatch(/from ["'][./]*release\.json["']/);
      expect(source, file).not.toMatch(/^import [^;]*from ["']\.\/lib\/bundledRelease["']/m);
    }
  });
});
