import { describe, expect, it } from "vitest";
import { newFileTab, newReleaseNotesWorkspaceTab, newTerminalFile } from "../lib/layout";
import { releaseNotesTitle } from "../lib/releaseNotes";
import { appendProblems, surfaceTabPresentation } from "./SurfaceTabs";

describe("surfaceTabPresentation", () => {
  it("labels release notes from their version", () => {
    const file = newReleaseNotesWorkspaceTab({ version: "0.1.23" })
      .editorPanes[0]?.files[0];
    if (!file) throw new Error("expected release-note file");

    expect(surfaceTabPresentation(file)).toEqual({
      name: releaseNotesTitle("0.1.23"),
      label: releaseNotesTitle("0.1.23"),
      iconName: "CHANGELOG.md",
      tooltip: releaseNotesTitle("0.1.23"),
    });
  });

  it("names a file tab by its basename with the path as tooltip, and nothing else", () => {
    const file = newFileTab("/repo/src/app.ts", "/repo");
    expect(surfaceTabPresentation(file)).toEqual({
      name: "app.ts",
      label: "app.ts",
      iconName: "app.ts",
      tooltip: "/repo/src/app.ts",
    });
  });

  it("says what a review tab is compared against", () => {
    const file = { ...newFileTab("/repo/src/app.ts", "/repo", true), diffBase: "a".repeat(40) };
    const presentation = surfaceTabPresentation(file);
    expect(presentation.label).toBe("app.ts (vs aaaaaaa)");
    expect(presentation.tooltip).toBe("/repo/src/app.ts (vs aaaaaaa)");
  });

  it("gives a terminal tab its directory as tooltip, without a middle dot", () => {
    const file = newTerminalFile("/repo", "zsh");
    expect(surfaceTabPresentation(file)).toEqual({
      name: "zsh",
      label: "zsh",
      iconName: "zsh",
      tooltip: "/repo",
    });
  });
});

describe("appendProblems", () => {
  it("leaves a clean file's tooltip alone", () => {
    expect(appendProblems("/repo/src/app.ts", 0)).toBe("/repo/src/app.ts");
  });

  it("singularises a lone problem", () => {
    expect(appendProblems("/repo/src/app.ts", 1)).toBe(
      "/repo/src/app.ts — 1 problem",
    );
  });

  it("pluralises the rest", () => {
    expect(appendProblems("/repo/src/app.ts", 4)).toBe(
      "/repo/src/app.ts — 4 problems",
    );
  });
});
