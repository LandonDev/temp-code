// @vitest-environment jsdom
/**
 * The host's echo of the person's message claims the optimistic row: the
 * bubble and the turn's working line stay the same elements, nothing fades
 * in again, and the line moves from Sending to its next phase in place.
 */
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";
import { setEditorConfigForTest } from "../lib/editorConfig";
import { sessionStore } from "../lib/tcserver/store";
import { emptyFold, foldEvent, foldOptimisticUser } from "../lib/tcserver/fold";
import { installTranscriptLayout, scene, settle } from "./transcriptScenario.testkit";

vi.mock("../lib/highlight", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

installTranscriptLayout();
beforeAll(() => setEditorConfigForTest(null));
afterEach(() => {
  cleanup();
  sessionStore.reset();
  MotionGlobalConfig.skipAnimations = false;
});

describe("the echo claims the optimistic row", () => {
  it("keeps the bubble and the working line, replays no fade, and the line moves on from Sending in place", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const sent = foldOptimisticUser(emptyFold(), "Add the index", []);
    const view = scene("s", sent.blocks as Block[], true);
    const bubble = view.bubble();
    const line = view.line();
    const row = bubble!.closest("[data-row]");
    expect(bubble).not.toBeNull();
    expect(line?.querySelector("[data-morph-key]")?.getAttribute("data-morph-key")).toBe("sending");
    const echoed = foldEvent(sent, { sessionId: "s", seq: 1, ts: 2_000, event: { type: "user-text", text: "Add the index" } }, "/r");
    expect(echoed.blocks[0].id).not.toBe(sent.blocks[0].id);
    view.show(echoed.blocks as Block[], true);
    await settle();
    expect(view.bubble()).toBe(bubble);
    expect(view.line()).toBe(line);
    expect(bubble!.closest("[data-row]")).toBe(row);
    // The row was on screen already: its fade is not played again.
    expect(row!.className).not.toContain("z-fade-in");
    expect(line?.querySelector("[data-morph-key]")?.getAttribute("data-morph-key")).not.toBe("sending");
    expect(line!.querySelectorAll("[data-morph-key]")).toHaveLength(1);
  });
});
