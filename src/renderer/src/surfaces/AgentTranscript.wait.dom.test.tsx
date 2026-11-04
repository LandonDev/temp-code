// @vitest-environment jsdom
/**
 * A wait on a subagent through the whole transcript: while it is open the
 * working line says "Waiting on <title>" and the wait draws no row; when it
 * returns, the line goes and the group holds "Finished <title>". The real
 * ActionGroup renders here (AgentTranscript.rows.dom.test.tsx probes it).
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { setEditorConfigForTest } from "../lib/editorConfig";

vi.mock("../lib/highlight", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

type Callback = (entries: ResizeObserverEntry[]) => void;
const observers = new Set<{ callback: Callback; targets: Set<Element> }>();
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  private entry: { callback: Callback; targets: Set<Element> };
  constructor(callback: Callback) {
    this.entry = { callback, targets: new Set() };
    observers.add(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.add(el);
  }
  unobserve(el: Element) {
    this.entry.targets.delete(el);
  }
  disconnect() {
    observers.delete(this.entry);
  }
};
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains("agent-transcript") ? 600 : 0;
  },
});

/** Fire a measurement of `height` px for the mounted row `key`. */
function measure(key: string, height: number): void {
  for (const { callback, targets } of observers) {
    const target = [...targets].find((el) => (el as HTMLElement).dataset.row === key);
    if (!target) continue;
    act(() =>
      callback([{ target, contentRect: { height } as DOMRectReadOnly, borderBoxSize: [{ blockSize: height, inlineSize: 800 }] } as unknown as ResizeObserverEntry]),
    );
  }
}

import { AgentTranscript } from "./AgentTranscript";

setEditorConfigForTest(null);

const child = { id: "c1", parentId: "s", provider: "claude", model: "claude-sonnet-5-5", permission: "edits", title: "Review the perf pass",
  cwd: "/repo", environmentId: "local", archived: false, status: "running", createdAt: 0 } as unknown as SessionMeta;
const user: Block = { id: "u0", role: "user", text: "Review it", seq: 1 };
const spoke: Block = { id: "a0", role: "assistant", text: "Spawning a reviewer.", seq: 2 };
const spawn: Block = {
  id: "sp",
  role: "tool",
  text: "spawn",
  seq: 3,
  tool: { callId: "sp", name: "mcp__orchestrator__spawn_agent", status: "completed", input: { task: "Review only. Do not edit, commit, push", title: "Review the perf pass" }, spawned: ["c1"] },
};
const wait = (status: string, detail?: string): Block => ({
  id: "w",
  role: "tool",
  text: "wait",
  seq: 4,
  tool: { callId: "w", name: "mcp__orchestrator__wait_for_agent", status, input: { agentId: "c1" }, detail },
});
const session = (blocks: Block[], busy: boolean) => ({ id: "s", status: busy ? ("running" as const) : ("idle" as const), busy, blocks });

afterEach(() => {
  cleanup();
  sessionStore.reset();
});

describe("AgentTranscript: a wait is the working line, then a step", () => {
  it("says Waiting on <title> with no wait row, then folds Finished <title> into the group", async () => {
    await act(async () => {
      sessionStore.injectPush({ push: "session", session: child }, "local");
      await new Promise((r) => setTimeout(r, 50));
    });
    const live = [user, spoke, spawn, wait("running")];
    const { container, rerender } = render(<AgentTranscript sessionId="s" turn={session(live, true)} blocks={live} busy visible />);
    const said = () => container.querySelector('[data-slot="turn-line"] [role="status"]')?.getAttribute("aria-label");
    expect(said()).toBe("Waiting on Review the perf pass");
    expect(container.querySelector('[data-block="w"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Waited for|Waiting for|Review only/);

    const done = [user, spoke, spawn, wait("completed", JSON.stringify({ agentId: "c1", status: "idle", reply: "Two issues." })), { id: "a1", role: "assistant" as const, text: "It found two issues.", seq: 5 }];
    // The phrase morphs to its past tense: the old words leave first (Motion's frames, skipped here).
    MotionGlobalConfig.skipAnimations = true;
    rerender(<AgentTranscript sessionId="s" turn={session(done, false)} blocks={done} busy={false} visible />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    MotionGlobalConfig.skipAnimations = false;
    // The working line moves on: it no longer says the wait, and the group holds its outcome.
    expect(said() ?? "").not.toMatch(/Waiting on/);
    const line = container.querySelector<HTMLButtonElement>("[data-group-line]")!;
    expect(line.textContent).toContain("Spawned “Review the perf pass”, heard from “Review the perf pass”");
    // Open it if the fold has closed it (the group holds open a moment after its work ends).
    if (line.getAttribute("aria-expanded") !== "true") {
      act(() => {
        fireEvent.click(line);
      });
    }
    const step = container.querySelector('[data-block="w"]')!;
    expect(step.textContent).toContain("Finished");
    expect(step.textContent).toContain("Review the perf pass");
    expect(container.textContent).not.toMatch(/Waited for|Review only/);
  });
});
