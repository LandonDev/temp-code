import { describe, expect, it } from "vitest";
import { skillProblem } from "@shared/skills";
import type { SkillFile } from "@shared/contract-skills";
import { bytesOf, canUntick, choiceOf, fileBytes, filesToSave, harnessesOf, isDirty, newSkillFiles, orderFiles, skillTemplate, type SkillDraft } from "./skillForm";

const png = "iVBORw0KGgo="; // 8 bytes
const FILES: SkillFile[] = [
  { path: "scripts/run.sh", text: "#!/bin/sh\n", executable: true },
  { path: "SKILL.md", text: "---\nname: polish\ndescription: Polish the UI\n---\n" },
  { path: "assets/logo.png", base64: png },
];

describe("skillForm", () => {
  it("lets a new skill's name line follow the Name field until SKILL.md is touched", () => {
    expect(newSkillFiles("polish", {})).toEqual([{ path: "SKILL.md", text: skillTemplate("polish") }]);
    expect(skillTemplate("polish")).toBe("---\nname: polish\ndescription: \n---\n\n");
    expect(newSkillFiles("renamed", { "SKILL.md": "mine" })).toEqual([{ path: "SKILL.md", text: "mine" }]);
  });

  it("lists SKILL.md first, then the rest by path", () => {
    expect(orderFiles(FILES).map((f) => f.path)).toEqual(["SKILL.md", "assets/logo.png", "scripts/run.sh"]);
  });

  it("applies the drafts to text files and passes binaries through", () => {
    const saved = filesToSave(FILES, { "SKILL.md": "edited", "assets/logo.png": "ignored" });
    expect(saved).toEqual([FILES[0], { path: "SKILL.md", text: "edited" }, FILES[2]]);
    expect(saved[0]).toBe(FILES[0]);
  });

  it("reads each file's bytes: UTF-8 for text, decoded for base64", () => {
    const [run, md, logo] = bytesOf(FILES);
    expect(run!.bytes).toEqual(new TextEncoder().encode("#!/bin/sh\n"));
    expect(md!.path).toBe("SKILL.md");
    expect([...logo!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(fileBytes(FILES[2]!)).toBe(8);
    expect(fileBytes({ path: "a", text: "é" })).toBe(2);
    expect(skillProblem("polish", bytesOf(FILES))).toBeNull();
  });

  it("turns the CLIs choice to and from all, never unticking the last", () => {
    expect(choiceOf("all")).toEqual({ claude: true, codex: true, muse: true });
    expect(harnessesOf({ claude: true, codex: true, muse: true })).toBe("all");
    expect(harnessesOf(choiceOf(["codex"]))).toEqual(["codex"]);
    expect(harnessesOf({ claude: true, codex: false, muse: true })).toEqual(["claude", "muse"]);
    expect(canUntick(choiceOf(["codex"]), "codex")).toBe(false);
    expect(canUntick(choiceOf(["codex", "muse"]), "codex")).toBe(true);
    expect(canUntick(choiceOf(["codex"]), "claude")).toBe(true);
  });

  it("tells a changed field or file from one opened and left alone", () => {
    const initial: SkillDraft = { name: "polish", workspaceId: null, choice: choiceOf("all"), drafts: {} };
    expect(isDirty(initial, initial, FILES)).toBe(false);
    expect(isDirty(initial, { ...initial, drafts: { "SKILL.md": FILES[1]!.text! } }, FILES)).toBe(false);
    expect(isDirty(initial, { ...initial, drafts: { "SKILL.md": "edited" } }, FILES)).toBe(true);
    expect(isDirty(initial, { ...initial, workspaceId: "ws_1" }, FILES)).toBe(true);
    expect(isDirty(initial, { ...initial, choice: choiceOf(["claude"]) }, FILES)).toBe(true);
    const fresh: SkillDraft = { name: "", workspaceId: null, choice: choiceOf("all"), drafts: {} };
    expect(isDirty(fresh, { ...fresh, name: "x" }, [])).toBe(true);
    expect(isDirty(fresh, fresh, [])).toBe(false);
  });
});
