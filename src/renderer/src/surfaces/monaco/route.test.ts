import { describe, expect, it } from "vitest";
import { editorForPath } from "./route";

describe("editorForPath", () => {
  it("sends every text file to Monaco", () => {
    for (const path of [
      "/p/App.java",
      "/p/Main.kt",
      "/p/build.gradle.kts",
      "/p/a.ts",
      "/p/a.mts",
      "/p/a.cts",
      "/p/a.tsx",
      "/p/a.js",
      "/p/style.css",
      "/p/index.html",
      "/p/data.json",
      "/p/Makefile",
      "/p/main.rs",
      "/p/.env",
      "/P/UPPER.JAVA",
    ]) {
      expect(editorForPath(path)).toBe("monaco");
    }
  });
  it("keeps Markdown in CodeMirror for its preview", () => {
    for (const path of ["/p/README.md", "/p/notes.markdown", "/p/page.MDX"]) {
      expect(editorForPath(path)).toBe("codemirror");
    }
  });
});
