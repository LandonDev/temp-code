import { describe, expect, it } from "vitest";
import type { ProjectFile } from "./fs";
import { mentionAttachments } from "./mentionAttachments";

const files: ProjectFile[] = [
  { name: "App.tsx", path: "/p/src/App.tsx", relative: "src/App.tsx" },
  { name: "Composer.tsx", path: "/p/src/chrome/Composer.tsx", relative: "src/chrome/Composer.tsx" },
];
const titleOf = (id: string) => (id === "abcdef123456" ? "Auth rewrite" : undefined);

describe("mentionAttachments", () => {
  it("turns file and thread tokens into server attachments", () => {
    expect(
      mentionAttachments(
        "read @App.tsx and @src/chrome/Composer.tsx, cf @thread:abcdef123456 @thread:zzzzzz999",
        files,
        titleOf,
      ),
    ).toEqual([
      { kind: "file", path: "/p/src/App.tsx", name: "App.tsx" },
      { kind: "file", path: "/p/src/chrome/Composer.tsx", name: "Composer.tsx" },
      { kind: "thread", path: "thread:abcdef123456", name: "Auth rewrite", sessionId: "abcdef123456" },
      { kind: "thread", path: "thread:zzzzzz999", name: "zzzzzz999", sessionId: "zzzzzz999" },
    ]);
  });

  it("skips directories, unknown paths, and notes", () => {
    expect(mentionAttachments("see @src and @nope.ts and @note/todo", files, titleOf)).toEqual([]);
    expect(mentionAttachments("@thread:abcdef123456", [], titleOf)).toHaveLength(1);
  });
});
