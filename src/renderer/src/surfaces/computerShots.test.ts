import { describe, expect, it } from "vitest";
import { formatShotLine, formatStepLine } from "@shared/computer/tools";
import type { Block } from "../lib/session";
import { appView } from "./appTool";
import { computerResultText, computerShotsOf, isComputerShotBlock } from "./computerShots";
import { groupTurnItems, isActivityBlock } from "./transcriptActivity";

const shot = { path: "/w/.temp-code/attachments/s1/computer/0003.jpg", width: 1280, height: 800 };
const header = 'app "TextEdit" · window "Untitled" · 1280×800 · changes since your last read';
/** The text a computer call answers: step lines, shot lines, a blank line, the observation. */
const result = (lines: string[]): string => [...lines, "", header].join("\n");
const call = (name: string, input: Record<string, unknown>, detail?: string, status = "completed"): Block => ({
  id: `b-${name}`,
  role: "tool",
  text: name,
  tool: { callId: "c1", name, input, detail, status },
});
const titleOf = () => undefined;

describe("computerShotsOf", () => {
  it("keeps a screenshot step's picture, named by the app the header says", () => {
    const text = result(["screenshot", formatShotLine(1, 1, shot, true)]);
    const b = call("mcp__app__computer_act", { app: "com.apple.TextEdit", action: "screenshot" }, `${text}\n[image]`);
    expect(computerShotsOf(b)).toEqual([{ ...shot, label: "Screenshot of TextEdit" }]);
    expect(isComputerShotBlock(b)).toBe(true);
  });

  it("keeps the observation's picture only when the model asked for it", () => {
    const text = result([formatShotLine(1, "observation", shot, true)]);
    expect(computerShotsOf(call("mcp__app__computer_observe", { app: "TextEdit", screenshot: true }, text))).toHaveLength(1);
    // a thin tree's picture the service attached on its own stays out
    expect(computerShotsOf(call("mcp__app__computer_observe", { app: "TextEdit" }, text))).toEqual([]);
  });

  it("keeps a picture past the attached ones: its file is still on disk", () => {
    const lines = [1, 2, 3, 4, 5].map((n) => formatShotLine(n, n, { ...shot, path: `/w/${n}.jpg` }, n <= 4));
    const actions = [1, 2, 3, 4, 5].map(() => ({ action: "screenshot" }));
    expect(computerShotsOf(call("mcp__app__computer_batch", { app: "TextEdit", actions }, result(lines))).map((s) => s.path)).toEqual(["/w/1.jpg", "/w/2.jpg", "/w/3.jpg", "/w/4.jpg", "/w/5.jpg"]);
  });

  it("reads codex's MCP result as its text parts", () => {
    const text = result(["screenshot", formatShotLine(1, 1, shot, true)]);
    const json = JSON.stringify({ content: [{ type: "text", text }, { type: "text", text: "[image]" }], isError: false }, null, 2);
    expect(computerResultText(json)).toBe(`${text}\n[image]`);
    expect(computerShotsOf(call("app.computer_act", { app: "TextEdit", action: "screenshot" }, json))).toHaveLength(1);
  });

  it("is nothing for a running call, a refusal or another tool", () => {
    const text = result(["screenshot", formatShotLine(1, 1, shot, true)]);
    expect(computerShotsOf(call("mcp__app__computer_act", { app: "TextEdit", action: "screenshot" }, text, "running"))).toEqual([]);
    expect(computerShotsOf(call("mcp__app__computer_act", { app: "TextEdit", action: "screenshot" }, "stopped by the person"))).toEqual([]);
    expect(computerShotsOf(call("Read", { file_path: shot.path }, formatShotLine(1, 1, shot, true)))).toEqual([]);
  });
});

describe("a computer call in the transcript", () => {
  const prose = (id: string): Block => ({ id, role: "assistant", text: "Done." });
  const read = (id: string): Block => ({ id, role: "tool", text: "Read", tool: { callId: id, name: "Read", kind: "read", title: "Read", status: "completed", input: { file_path: "/r/a.ts" } } });
  const pictured = call("mcp__app__computer_act", { app: "TextEdit", action: "screenshot" }, result(["screenshot", formatShotLine(1, 1, shot, true)]));

  it("folds into its group while it runs, and once it settles with a picture stands as its own row there", () => {
    const running = call("mcp__app__computer_act", { app: "TextEdit", action: "screenshot" }, undefined, "running");
    expect(groupTurnItems([read("r1"), running, read("r2")]).map((i) => i.type)).toEqual(["activity"]);
    expect(isActivityBlock(pictured)).toBe(false);
    const items = groupTurnItems([read("r1"), pictured, read("r2"), prose("p")]);
    expect(items.map((i) => (i.type === "block" ? i.block.id : i.blocks.map((b) => b.id).join(",")))).toEqual(["r1", pictured.id, "r2", "p"]);
  });

  it("a settled call without an asked picture stays a step of its group", () => {
    const clicked = call("mcp__app__computer_act", { app: "TextEdit", action: "left_click", element: 14 }, result(["left_click [14] button \"Save\" · ax · changed"]));
    expect(groupTurnItems([read("r1"), clicked]).map((i) => i.type)).toEqual(["activity"]);
  });

  it("says its row in words: settled from the step lines, live from the input, a batch with its tally", () => {
    const step = formatStepLine({ index: 0, action: "left_click", status: "ok", tier: "ax", effect: "changed", element: { index: 14, line: 'button "Save"' } }, { action: "left_click", element: 14 });
    const clicked = call("mcp__app__computer_act", { app: "com.apple.TextEdit", action: "left_click", element: 14 }, result([step]));
    expect(appView(clicked, titleOf, false)).toEqual({ label: "Clicked", detail: "Save in TextEdit", phrase: "clicked Save in TextEdit", glyph: "computer" });
    expect(appView(clicked, titleOf, true)).toMatchObject({ label: "Clicking", detail: "in com.apple.TextEdit" });
    const batch = call("app.computer_batch", { app: "Mail", actions: [{ action: "left_click", element: 3 }, { action: "type", text: "secret" }, { action: "key", text: "super+Return" }] }, result([]));
    expect(appView(batch, titleOf, false)).toMatchObject({ label: "Worked", detail: "in TextEdit", tally: "3 steps", glyph: "computer" });
    expect(appView(call("mcp__app__computer_observe", { app: "TextEdit" }, header), titleOf, false)).toMatchObject({ label: "Read", detail: "TextEdit", phrase: "read TextEdit" });
  });
});
