// @vitest-environment jsdom
/**
 * Coming back to a thread on the real streamdown pipeline (the dom project
 * stubs streamdown out, so this runs in the node project with jsdom per
 * file): a reply that settled while the tab was parked is drawn whole on the
 * first paint after the reader returns, with no reveal step and no fade; a
 * reply still streaming then shows what has arrived and streams on from
 * there.
 */
import "../test/domSetup";

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";

vi.mock("../lib/highlight", () => ({
  highlight: () => Promise.resolve(null),
  highlightCached: () => undefined,
  highlightCode: () => Promise.resolve(null),
}));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
if (typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => {};
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains("agent-transcript") ? 600 : 0;
  },
});

import { REVEAL } from "../lib/ease";
import { AgentTranscript } from "./AgentTranscript";
import { setEditorConfigForTest } from "../lib/editorConfig";

const FAKE = ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] as const;

const REPLY = "The gateway picks the account with the most room left and keeps a sticky thread on its own account while the cache is warm";
const user = (id: string, seq: number): Block => ({ id, role: "user", text: `Ask ${id}`, seq });
const answer = (id: string, seq: number, text: string, streaming = false): Block => ({ id, role: "assistant", text, seq, streaming });
const first = [user("u0", 1), answer("a0", 2, "Hello there")];

function view(blocks: Block[], visible: boolean, busy = false) {
  return <AgentTranscript sessionId="s" blocks={blocks} busy={busy} visible={visible} />;
}

/** The reply's paragraph, by its opening words. */
const reply = (container: HTMLElement): HTMLElement | undefined =>
  Array.from(container.querySelectorAll<HTMLElement>(".agent-markdown")).find((el) => el.textContent?.startsWith("The gateway"));

describe("AgentTranscript: returning to a thread", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    setEditorConfigForTest(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a settled thread left and opened again, parked or remounted, draws its last reply whole", () => {
    const settled = [...first, user("u1", 3), answer("a1", 4, REPLY)];
    const parked = render(view(settled, true));
    parked.rerender(view(settled, false));
    parked.rerender(view(settled, true));
    expect(reply(parked.container)?.textContent).toBe(REPLY);
    expect(parked.container.querySelector("[data-reveal-step], .stream-step, .z-fade-in")).toBeNull();
    parked.unmount();
    // The tab left the warm set: the pane mounts again on the loaded rows.
    const again = render(view(settled, true));
    expect(reply(again.container)?.textContent).toBe(REPLY);
    expect(again.container.querySelector("[data-reveal-step], .stream-step, .z-fade-in")).toBeNull();
  });

  it("a reply that settled while the tab was parked is drawn whole at once, with no reveal step", () => {
    const { container, rerender } = render(view(first, true));
    // The reader leaves; the next turn streams and settles while they are away.
    rerender(view(first, false));
    rerender(view([...first, user("u1", 3), answer("a1", 4, REPLY.slice(0, 40), true)], false, true));
    rerender(view([...first, user("u1", 3), answer("a1", 4, REPLY)], false));
    act(() => vi.advanceTimersByTime(5000));
    // They come back: the first paint carries the whole reply.
    rerender(view([...first, user("u1", 3), answer("a1", 4, REPLY)], true));
    expect(reply(container)?.textContent).toBe(REPLY);
    expect(container.querySelector("[data-reveal-step], .stream-step")).toBeNull();
    expect(container.querySelector(".z-fade-in")).toBeNull();
    // And nothing plays afterwards.
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 3));
    expect(reply(container)?.textContent).toBe(REPLY);
    expect(container.querySelector("[data-reveal-step], .stream-step")).toBeNull();
  });

  it("a reply still streaming when the reader comes back shows what arrived, then streams on", () => {
    const { container, rerender } = render(view(first, true));
    rerender(view(first, false));
    // Up to a word's end: the reveal holds a word still arriving.
    const arrived = REPLY.slice(0, REPLY.indexOf(" and ") + 1);
    rerender(view([...first, user("u1", 3), answer("a1", 4, arrived, true)], false, true));
    rerender(view([...first, user("u1", 3), answer("a1", 4, arrived, true)], true, true));
    expect(reply(container)?.textContent?.trim()).toBe(arrived.trim());
    // What comes next reveals in steps, once the lead it holds has passed.
    rerender(view([...first, user("u1", 3), answer("a1", 4, REPLY, true)], true, true));
    for (let n = 0; n < 4; n++) act(() => vi.advanceTimersByTime(REVEAL.stepMs));
    const shown = reply(container)?.textContent ?? "";
    expect(shown.startsWith(arrived.trim())).toBe(true);
    expect(shown.length).toBeGreaterThan(arrived.trim().length);
    expect(container.querySelector("[data-reveal-step]")).not.toBeNull();
  });
});
