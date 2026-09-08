import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import {
  editModel,
  editVerb,
  isEditBlock,
  parseApplyPatchText,
  parsePatchDiff,
  splitPath,
} from "./editModel";

const tool = (
  name: string,
  input: unknown,
  extra: Partial<NonNullable<Block["tool"]>> = {},
): Block =>
  ({
    id: "b1",
    role: "tool",
    text: "",
    tool: { callId: "c1", name, kind: "edit", input, ...extra },
  }) as unknown as Block;

describe("isEditBlock", () => {
  it("matches the provider edit tools by name", () => {
    for (const n of ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]) {
      expect(isEditBlock(tool(n, {}, { kind: "other" }))).toBe(true);
    }
  });

  it("matches by kind and by write preview", () => {
    expect(isEditBlock(tool("x", {}, { kind: "delete" }))).toBe(true);
    expect(isEditBlock(tool("x", {}, { kind: "other", preview: { kind: "write" } }))).toBe(true);
  });

  it("leaves reads and runs alone", () => {
    expect(isEditBlock(tool("Read", {}, { kind: "read" }))).toBe(false);
    expect(isEditBlock(tool("Bash", {}, { kind: "execute" }))).toBe(false);
    expect(isEditBlock({ id: "t", role: "assistant", text: "hi" } as unknown as Block)).toBe(false);
  });
});

describe("parsePatchDiff", () => {
  it("counts + and − lines, skipping headers", () => {
    const diff = ["--- a", "+++ b", "@@ -1,2 +1,3 @@", " ctx", "-old", "+new", "+more"].join("\n");
    expect(parsePatchDiff(diff, false)).toEqual({ adds: 2, dels: 1 });
  });

  it("counts every line of an added file", () => {
    expect(parsePatchDiff("a\nb\nc", true)).toEqual({ adds: 3, dels: 0 });
    expect(parsePatchDiff("", true)).toEqual({ adds: 0, dels: 0 });
  });

  it("treats marker-less content as whole-file content", () => {
    expect(parsePatchDiff("x\ny", false)).toEqual({ adds: 2, dels: 0 });
  });
});

describe("parseApplyPatchText", () => {
  it("reads per-file headers and bodies", () => {
    const text = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "+export const b = 2;",
      "*** Update File: src/old.ts",
      "@@",
      "-const x = 1;",
      "+const x = 2;",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(parseApplyPatchText(text).files).toEqual([
      { path: "src/new.ts", create: true, remove: false, adds: 2, dels: 0 },
      { path: "src/old.ts", create: false, remove: false, adds: 1, dels: 1 },
      { path: "src/gone.ts", create: false, remove: true, adds: 0, dels: 0 },
    ]);
  });
});

describe("editModel", () => {
  it("counts an Edit from old and new strings", () => {
    const m = editModel(tool("Edit", { file_path: "/p/a.ts", old_string: "a\nb", new_string: "c" }));
    expect(m).toMatchObject({ path: "/p/a.ts", adds: 1, dels: 2, create: false, remove: false, verb: "Editing…" });
  });

  it("sums MultiEdit hunks", () => {
    const m = editModel(
      tool("MultiEdit", {
        file_path: "/p/a.ts",
        edits: [
          { old_string: "a", new_string: "b\nc" },
          { old_string: "d\ne\nf", new_string: "" },
        ],
      }),
    );
    expect(m).toMatchObject({ adds: 2, dels: 4 });
  });

  it("marks a Write as created with every line added", () => {
    const m = editModel(tool("Write", { file_path: "/p/n.md", content: "one\ntwo\nthree" }));
    expect(m).toMatchObject({ path: "/p/n.md", adds: 3, dels: 0, create: true, verb: "Writing…" });
  });

  it("falls back to the preview counts while input is still streaming", () => {
    const m = editModel(
      tool("Edit", { file_path: "/p/a.ts" }, { preview: { kind: "write", path: "/p/a.ts", additions: 4, deletions: 1 } }),
    );
    expect(m).toMatchObject({ path: "/p/a.ts", adds: 4, dels: 1 });
  });

  it("counts preview lines when the event carries no totals", () => {
    const m = editModel(
      tool("foreign_edit", {}, {
        kind: "edit",
        preview: {
          kind: "write",
          path: "/p/a.ts",
          lines: [
            { kind: "add", text: "a" },
            { kind: "add", text: "b" },
            { kind: "del", text: "c" },
            { kind: "context", text: "d" },
          ],
        },
      }),
    );
    expect(m).toMatchObject({ path: "/p/a.ts", adds: 2, dels: 1 });
  });

  it("shows the verb only when nothing gives counts", () => {
    const m = editModel(tool("Edit", { file_path: "/p/a.ts" }));
    expect(m).toMatchObject({ path: "/p/a.ts", adds: 0, dels: 0, verb: "Editing…" });
  });

  it("reads a normalized apply_patch change", () => {
    const m = editModel(
      tool("apply_patch", [
        { path: "src/x.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n+c" },
      ]),
    );
    expect(m).toMatchObject({ path: "src/x.ts", adds: 2, dels: 1, verb: "Patching…" });
  });

  it("lists further files of a multi-file patch", () => {
    const m = editModel(
      tool("apply_patch", [
        { path: "a.ts", kind: { type: "add" }, diff: "x" },
        { path: "b.ts", kind: { type: "update" }, diff: "" },
      ]),
    );
    expect(m).toMatchObject({ path: "a.ts", extraPaths: ["b.ts"], create: true });
  });

  it("flags a delete", () => {
    const m = editModel(tool("apply_patch", [{ path: "gone.ts", kind: { type: "delete" }, diff: "" }]));
    expect(m).toMatchObject({ path: "gone.ts", remove: true, verb: "Deleting…" });
    const byKind = editModel(tool("remove_file", { path: "/p/gone.ts" }, { kind: "delete" }));
    expect(byKind).toMatchObject({ path: "/p/gone.ts", remove: true, verb: "Deleting…" });
  });
});

describe("editVerb", () => {
  it("picks by state then by tool", () => {
    expect(editVerb({ create: false, remove: true }, "Edit")).toBe("Deleting…");
    expect(editVerb({ create: true, remove: false }, "foreign")).toBe("Writing…");
    expect(editVerb({ create: false, remove: false }, "apply_patch")).toBe("Patching…");
    expect(editVerb({ create: false, remove: false }, "Edit")).toBe("Editing…");
  });
});

describe("splitPath", () => {
  it("shows the project-relative dir and basename", () => {
    expect(splitPath("/repo/src/a/b.ts", "/repo")).toEqual({ name: "b.ts", dir: "src/a" });
  });

  it("keeps outside paths whole", () => {
    expect(splitPath("/tmp/x.log", "/repo")).toEqual({ name: "x.log", dir: "/tmp" });
  });

  it("handles a bare name", () => {
    expect(splitPath("README.md", "/repo")).toEqual({ name: "README.md", dir: "" });
  });
});
