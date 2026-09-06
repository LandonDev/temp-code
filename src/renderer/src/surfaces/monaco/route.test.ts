import { describe, expect, it } from "vitest";
import { editorForPath } from "./route";

describe("editorForPath", () => {
  it("sends JVM and web sources to Monaco", () => {
    for (const path of ["/p/App.java", "/p/Main.kt", "/p/build.gradle.kts", "/p/a.ts", "/p/a.tsx", "/p/a.js", "/p/a.jsx", "/p/a.mjs", "/p/a.cjs", "/P/UPPER.JAVA"]) {
      expect(editorForPath(path)).toBe("monaco");
    }
  });
  it("keeps everything else in CodeMirror", () => {
    for (const path of ["/p/README.md", "/p/style.css", "/p/index.html", "/p/data.json", "/p/Makefile", "/p/main.rs", "/p/.java"]) {
      expect(editorForPath(path)).toBe("codemirror");
    }
  });
});
