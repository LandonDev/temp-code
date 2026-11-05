// @vitest-environment jsdom
/**
 * The agent row: three lines while the agent is live, two settled; the
 * state's glyph leading, the title across line one with the host glyph
 * last, the word only where the heading does not say it, the tally and a
 * time that ticks only while live, the model line last (logo, model,
 * effort, context window) with the role in its tooltip, Open and Stop on
 * hover.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ interrupt: vi.fn(() => Promise.resolve()) }));
vi.mock("../../../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tcserver/commands")>()),
  interrupt: h.interrupt,
}));

import { tooltipChunk, warmTooltips } from "../../../components/ui/tooltip";
import { agentStatus } from "../../../lib/threads/agents";
import { modelContextWord, modelMarkName } from "../ModelMark";
import { AgentRow, AgentRowView } from "./AgentRow";
import { FLEET_ROWS, fixtureHostGlyph, fixtureMeta } from "./fleetFixture";

/** The window word a fixture row's model line says, if any. */
const contextOf = (meta: Parameters<typeof modelContextWord>[0]) => (modelContextWord(meta) ? [modelContextWord(meta)] : []);
const row = (title: string) => FLEET_ROWS.find((r) => r.meta.title === title)!;
const tipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
const hover = (el: Element) => {
  fireEvent.pointerEnter(el);
  fireEvent.mouseEnter(el);
  fireEvent.focus(el);
};

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.interrupt.mockClear();
});

describe("AgentRowView", () => {
  it("carries the provider's mark and the short model, the role first in its tooltip", async () => {
    const meta = fixtureMeta("r", { title: "Review the fold", agentType: "reviewer", status: "running", context1m: true });
    const { container } = render(<AgentRowView meta={meta} status={agentStatus(meta)} onOpen={() => {}} />);
    const mark = container.querySelector("[data-model]")!;
    expect(mark.querySelector("img, svg")).not.toBeNull();
    expect(mark.textContent).toBe("Opus 5.5High1M");
    hover(mark);
    await waitFor(() => expect(tipText()).toBe("Reviewer, Claude Opus 5.5, high effort, 1M context"), { timeout: 2000 });
  });

  it("holds line one to the glyph, the title and the host glyph last, with nothing between title and host", () => {
    const meta = fixtureMeta("far", { title: "A title long enough to need every pixel of the row", status: "running", environmentId: "env_box" });
    const { container } = render(<AgentRowView meta={meta} status={agentStatus(meta)} hostGlyph={fixtureHostGlyph} onOpen={() => {}} />);
    const head = container.querySelector("[data-row-head]")!;
    const kids = [...head.children];
    expect(kids).toHaveLength(2);
    expect(kids[0].matches("[data-row-title]")).toBe(true);
    expect(kids[1].matches("[data-host-glyph]")).toBe(true);
    expect(head.querySelector("[data-model]")).toBeNull();
    const title = kids[0].className;
    expect(title).toContain("flex-1");
    expect(title).toContain("min-w-0");
    expect(title).toContain("truncate");
    expect(title).not.toContain("shrink-[1000]");
  });

  it("draws the model line last: the logo, the model, the effort, the context window", () => {
    const { meta, status } = row("Review the fold");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    const lines = [...container.querySelector('[role="button"]')!.children].filter((el) => el.matches("[data-row-head], [data-row-status], [data-model-line]"));
    expect(lines.map((el) => (el as HTMLElement).dataset.rowHead !== undefined ? "head" : (el as HTMLElement).dataset.rowStatus !== undefined ? "status" : "model")).toEqual([
      "head",
      "status",
      "model",
    ]);
    const line = container.querySelector("[data-model-line]")!;
    expect(line.className).toContain("text-xs");
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).toContain("gap-1");
    const order = [...line.querySelectorAll("[data-model] :is(img, svg), [data-model-name], [data-model-effort], [data-model-context]")].map((el) =>
      el.matches("img, svg") ? "logo" : el.textContent,
    );
    expect(order).toEqual(["logo", modelMarkName("codex", "gpt-6-astra"), "Extra high", ...contextOf(meta)]);
  });

  it("truncates only the model's name; the effort and the window stay whole", () => {
    const meta = fixtureMeta("w", { status: "running", context1m: true });
    const { container } = render(<AgentRowView meta={meta} status={agentStatus(meta)} onOpen={() => {}} />);
    expect(container.querySelector("[data-model-name]")!.className).toContain("truncate");
    expect(container.querySelector("[data-model-effort]")!.className).toContain("shrink-0");
    expect(container.querySelector("[data-model-context]")!.className).toContain("shrink-0");
    expect(container.innerHTML).not.toContain("13rem");
  });

  it("says the context window in the composer's words", () => {
    const say = (over: Parameters<typeof fixtureMeta>[1]) => {
      const meta = fixtureMeta("c", over);
      const view = render(<AgentRowView meta={meta} status={agentStatus(meta)} onOpen={() => {}} />);
      const word = view.container.querySelector("[data-model-context]")?.textContent ?? null;
      view.unmount();
      return word;
    };
    expect(say({ provider: "claude", model: "claude-opus-5-5", context1m: true })).toBe("1M");
    expect(say({ provider: "claude", model: "claude-opus-5-5", context1m: false })).toBe("200k");
    expect(say({ provider: "codex", model: "muse-wonder-1.0", reasoning: "high" })).toBe("1M");
    expect(say({ provider: "codex", model: "gpt-6.1-sol", context: { tokens: 1000, window: 272_000 } })).toBe("272k");
    expect(say({ provider: "cursor", model: "composer-2.5", reasoning: undefined })).toBeNull();
  });

  it("ends a settled row's model line with how long it ran", () => {
    const { meta, status } = row("Find the row sizes");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    const line = container.querySelector("[data-model-line]")!;
    const mark = line.querySelector("[data-model]")!;
    const time = line.querySelector("[data-agent-time]")!;
    expect(mark.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mark.querySelector("[data-model-effort]")?.textContent).toBe("Low");
  });

  it("names an untitled agent Subagent", () => {
    const meta = fixtureMeta("x", { title: "" });
    const { container } = render(<AgentRowView meta={meta} status={agentStatus(meta)} onOpen={() => {}} />);
    expect(container.querySelector("[data-row-title]")?.textContent).toBe("Subagent");
  });

  it("turns one spinner on a working row and none on any other", () => {
    for (const r of FLEET_ROWS) {
      const { container, unmount } = render(<AgentRowView meta={r.meta} status={r.status} onOpen={() => {}} />);
      const turning = container.querySelectorAll('[data-slot="spinner"][data-turning]').length;
      expect([r.meta.title, turning]).toEqual([r.meta.title, r.status.state === "working" ? 1 : 0]);
      unmount();
    }
  });

  it("draws a done row on two lines, its check and title over the model line and how long it ran", async () => {
    const { meta, status } = row("Find the row sizes");
    const { container } = render(<AgentRowView meta={meta} status={status} heading="Done" onOpen={() => {}} />);
    const el = container.querySelector('[role="button"]')!;
    expect(el.className).toContain("py-1");
    expect(el.className).not.toContain("h-7");
    expect(container.querySelector("[data-row-status]")).toBeNull();
    expect(container.querySelector("[data-row-head]")).not.toBeNull();
    expect(container.querySelector("[data-model-line]")).not.toBeNull();
    expect(container.querySelector('[data-row-glyph] [data-state="done"]')).not.toBeNull();
    expect(container.querySelector("[data-row-title]")?.className).toContain("text-muted-foreground");
    const time = container.querySelector("[data-agent-time]")!;
    expect(time.textContent).toBe("1m 14s");
    hover(time);
    await waitFor(() => expect(tipText()).toMatch(/^Finished \d{1,2}:\d\d([ \u202f][AP]M)?$/), { timeout: 2000 });
  });

  it("draws a live row on three lines, the title in the foreground", () => {
    const { meta, status } = row("Build the shell");
    const { container } = render(<AgentRowView meta={meta} status={status} heading="Working" onOpen={() => {}} />);
    expect(container.querySelector('[role="button"]')!.className).toContain("py-1");
    expect(container.querySelector("[data-row-title]")?.className).toContain("text-foreground");
    const line = container.querySelector("[data-row-status]")!;
    expect(line.querySelector('[data-slot="status-word"]')).toBeNull();
    expect(line.querySelector('[data-slot="status-detail"]')?.textContent).toBe("Editing HomeView.swift");
  });

  it("leaves a waiting row's word to its heading and says the detail in amber", () => {
    const { meta, status } = row("Review the fold");
    const under = render(<AgentRowView meta={meta} status={status} heading="Needs you" onOpen={() => {}} />);
    const line = under.container.querySelector("[data-row-status]")!;
    expect(line.querySelector('[data-slot="status-word"]')).toBeNull();
    expect(line.querySelector('[data-slot="status-detail"]')?.textContent).toBe("Approve rm -rf ios/TempCodeClient/.build");
    expect(line.querySelector('[data-slot="status-mark"]')?.className).toContain("**:data-[slot=status-detail]:text-current");
    under.unmount();
    const alone = render(<AgentRowView meta={meta} status={{ ...status, detail: "" }} heading="Needs you" onOpen={() => {}} />);
    expect(alone.container.querySelector('[data-row-status] [data-slot="status-word"]')?.textContent).toBe("Needs you");
    alone.unmount();
    const bare = render(<AgentRowView meta={meta} status={status} heading={null} onOpen={() => {}} />);
    expect(bare.container.querySelector('[data-row-status] [data-slot="status-word"]')?.textContent).toBe("Needs you");
  });

  it("says Failed in red under Needs you", () => {
    const { meta, status } = row("Port module 10");
    const { container } = render(<AgentRowView meta={meta} status={status} heading="Needs you" onOpen={() => {}} />);
    const mark = container.querySelector('[data-row-status] [data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("failed");
    expect(mark.className).toContain("text-destructive");
    expect(mark.querySelector('[data-slot="status-word"]')?.textContent).toBe("Failed");
    expect(mark.querySelector('[data-slot="status-detail"]')?.textContent).toBe("Usage cap reached on work");
  });

  it("ends line two with the task tally", () => {
    const { meta, status } = row("Build the shell");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    expect(container.querySelector("[data-tally]")?.textContent).toBe("3/7");
    const none = fixtureMeta("n", { status: "running", tasks: { done: 0, total: 0 } });
    const other = render(<AgentRowView meta={none} status={agentStatus(none)} onOpen={() => {}} />);
    expect(other.container.querySelector("[data-tally]")).toBeNull();
  });

  it("ticks a working row's time and holds a settled one still", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const working = fixtureMeta("w", { status: "running", busySince: Date.now() - 10_000 });
    const done = fixtureMeta("d", { status: "idle", createdAt: 1_799_999_000_000, lastEventAt: 1_799_999_030_000 });
    const live = render(<AgentRowView meta={working} status={agentStatus(working)} onOpen={() => {}} />);
    const still = render(<AgentRowView meta={done} status={agentStatus(done)} onOpen={() => {}} />);
    const liveTime = () => live.container.querySelector("[data-agent-time]")?.textContent;
    const stillTime = () => still.container.querySelector("[data-agent-time]")?.textContent;
    expect(liveTime()).toBe("10s");
    expect(stillTime()).toBe("30s");
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(liveTime()).toBe("13s");
    expect(stillTime()).toBe("30s");
  });

  it("draws the host glyph only from its prop", () => {
    const meta = fixtureMeta("far", { title: "Far", environmentId: "env_box" });
    const none = render(<AgentRowView meta={meta} status={agentStatus(meta)} onOpen={() => {}} />);
    expect(none.container.querySelector("[data-host-glyph]")).toBeNull();
    none.unmount();
    const two = render(<AgentRowView meta={meta} status={agentStatus(meta)} hostGlyph={fixtureHostGlyph} onOpen={() => {}} />);
    expect(two.container.querySelector("[data-host-glyph]")?.getAttribute("aria-label")).toBe("The box");
  });

  it("offers Open on every row and Stop only while a turn runs, neither opening the detail", () => {
    const onOpen = vi.fn();
    const onOpenSession = vi.fn();
    const onStop = vi.fn();
    const { meta, status } = row("Build the shell");
    const live = render(<AgentRowView meta={meta} status={status} onOpen={onOpen} onOpenSession={onOpenSession} onStop={onStop} />);
    fireEvent.click(live.getByRole("button", { name: "Open" }));
    fireEvent.click(live.getByRole("button", { name: "Stop" }));
    expect(onOpenSession).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    live.unmount();
    const done = row("Port module 4");
    const settled = render(<AgentRowView meta={done.meta} status={done.status} onOpen={onOpen} onOpenSession={onOpenSession} onStop={onStop} />);
    expect(settled.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(settled.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("waits --delay-hover before showing its actions and shows them at once on focus", () => {
    const { meta, status } = row("Build the shell");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} onOpenSession={() => {}} />);
    const actions = container.querySelector("[data-actions]")!.className;
    expect(actions).toContain("opacity-0");
    expect(actions).toContain("group-hover:delay-(--delay-hover)");
    expect(actions).toContain("group-focus-within:delay-(--dur-instant)");
    // Line one's end gives way under them on the same timing; the model line stays put.
    const head = container.querySelector("[data-row-head]")!.className;
    expect(head).toContain("group-hover:[mask-size:100%_100%]");
    expect(head).toContain("group-hover:delay-(--delay-hover)");
    expect(head).toContain("group-focus-within:delay-(--dur-instant)");
    expect(container.querySelector("[data-model-line]")!.className).not.toContain("group-hover");
    expect(container.querySelector("[data-model]")!.className).not.toContain("opacity-0");
  });

  it("masks line one only when the row has actions", () => {
    const { meta, status } = row("Port module 4");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    expect(container.querySelector("[data-row-head]")!.className).not.toContain("mask");
  });

  it("opens the detail on click, Enter and Space, and marks the selected row", () => {
    const onOpen = vi.fn();
    const { meta, status } = row("Port module 4");
    const { container, rerender } = render(<AgentRowView meta={meta} status={status} onOpen={onOpen} />);
    const el = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(el.hasAttribute("aria-current")).toBe(false);
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(3);
    rerender(<AgentRowView meta={meta} status={status} selected onOpen={onOpen} />);
    expect(el.getAttribute("aria-current")).toBe("true");
  });

  it("is named by its title, state, tally, time, role and model", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const meta = fixtureMeta("n", {
      title: "Build the shell",
      status: "running",
      activity: "Editing HomeView.swift",
      busySince: Date.now() - 151_000,
      tasks: { done: 3, total: 7 },
    });
    render(<AgentRowView meta={meta} status={agentStatus(meta)} onOpen={() => {}} />);
    expect(
      screen.getByRole("button", {
        name: "Build the shell, Working: Editing HomeView.swift, 3 of 7 tasks, 2m 31s, Implementer, Claude Opus 5.5, high effort, 200k context",
      }),
    ).toBeTruthy();
  });

  it("indents a descendant 16px a level", () => {
    const { meta, status } = row("Port module 4");
    const { container } = render(<AgentRowView meta={meta} status={status} depth={2} onOpen={() => {}} />);
    expect(container.querySelector('[role="button"]')!.className).toContain("ms-8");
  });
});

describe("AgentRow", () => {
  it("stops the agent's turn through the host", () => {
    const { meta } = row("Build the shell");
    const { getByRole } = render(<AgentRow agent={meta} onOpen={() => {}} />);
    fireEvent.click(getByRole("button", { name: "Stop" }));
    expect(h.interrupt).toHaveBeenCalledWith("ios-orch-a1");
  });
});

