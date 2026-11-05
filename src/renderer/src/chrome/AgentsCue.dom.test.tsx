// @vitest-environment jsdom
/**
 * The title bar's agents cue (UI-23): nothing at zero, the count in
 * tabular numerals, waiting's amber leading, working's still dot while the
 * thread's own turn runs, a click that opens and closes the panel on
 * Agents, and the no-room state the panel toggle has.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { NO_ROOM_LABEL, rightPanel } from "../lib/rightPanel";
import { sessionStore } from "../lib/tcserver/store";
import { agentsCue } from "../lib/threads/agents";
import { FakeMetaLink, wireMeta } from "../test/fakeMetaLink";
import { AgentsCue, AgentsCueView } from "./AgentsCue";
import { AgentsCueEndGroup } from "./AgentsCue.preview";
import FIXTURES from "./AgentsCue.preview.fixtures";

const cue = (working: number, waiting = 0, queued = 0, rootRunning = false) => agentsCue({ working, waiting, queued }, rootRunning)!;
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));
const button = () => document.querySelector<HTMLElement>("[data-agents-cue]");

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});

afterEach(() => {
  cleanup();
  rightPanel.reset();
});

describe("AgentsCueView", () => {
  it("says the count in tabular numerals, named by its line", () => {
    const one = render(<AgentsCueView cue={cue(1)} pressed={false} onClick={() => {}} />);
    expect(one.getByRole("button", { name: "Agents: 1 working" }).textContent).toBe("1 agent");
    one.unmount();
    render(<AgentsCueView cue={cue(2, 1, 1)} pressed={false} onClick={() => {}} />);
    const el = screen.getByRole("button", { name: "Agents: 1 needs you, 2 working, 1 queued" });
    expect(el.textContent).toBe("4 agents");
    expect(el.querySelector(".tabular-nums")?.textContent).toBe("4 agents");
  });

  it("leads with waiting's amber when one needs you", () => {
    render(<AgentsCueView cue={cue(2, 1)} pressed={false} onClick={() => {}} />);
    expect(button()!.getAttribute("data-state")).toBe("waiting");
    const mark = button()!.querySelector('[data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("waiting");
    expect(mark.className).toContain("text-warning");
  });

  it("draws the working dot while the thread's own turn runs, the spinner while it watches", () => {
    const running = render(<AgentsCueView cue={cue(2, 0, 0, true)} pressed={false} onClick={() => {}} />);
    expect(running.container.querySelector('[data-slot="working-dot"]')).not.toBeNull();
    expect(running.container.querySelector('[data-slot="spinner"]')).toBeNull();
    running.unmount();
    const watching = render(<AgentsCueView cue={cue(2)} pressed={false} onClick={() => {}} />);
    expect(watching.container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(watching.container.querySelector('[data-slot="working-dot"]')).toBeNull();
  });

  it("fades in on entry and carries the pressed fill", () => {
    render(<AgentsCueView cue={cue(1)} pressed onClick={() => {}} />);
    const cls = button()!.className;
    expect(cls).toContain("starting:opacity-0");
    expect(cls).toContain("duration-(--dur-fast)");
    expect(cls).toContain("motion-reduce:transition-opacity");
    expect(cls).toContain("aria-pressed:bg-foreground/7");
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("with no room for the panel is aria-disabled, says why on hover and does nothing on click", async () => {
    let clicks = 0;
    render(<AgentsCueView cue={cue(1)} pressed room={false} onClick={() => clicks++} />);
    const el = button()!;
    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(el);
    expect(clicks).toBe(0);
    fireEvent.pointerEnter(el, { pointerType: "mouse" });
    fireEvent.mouseEnter(el);
    fireEvent.mouseMove(el);
    await waitFor(() => expect(screen.getByText(NO_ROOM_LABEL)).toBeTruthy(), { timeout: 1500 });
  });

  it("renders every preview fixture, the zero one with no cue beside ⋯ and Panel", () => {
    for (const f of FIXTURES) {
      const { container, unmount } = render(<AgentsCueEndGroup {...f.props} />);
      expect([f.name, !!container.querySelector("[data-agents-cue]")]).toEqual([f.name, f.props.cue !== null]);
      expect(container.querySelector('[aria-label="Thread menu"]')).not.toBeNull();
      unmount();
    }
  });
});

describe("AgentsCue", () => {
  let link: FakeMetaLink;
  beforeEach(async () => {
    sessionStore.reset();
    link = new FakeMetaLink();
    link.metas = [wireMeta("root", { status: "idle" }), wireMeta("kid", { parentId: "root", status: "running" })];
    sessionStore.attach(link);
    await sessionStore.ready();
  });
  afterEach(() => sessionStore.reset());

  it("renders nothing while no subagent is live", async () => {
    link.push({ push: "session", session: wireMeta("kid", { parentId: "root", status: "idle" }) });
    await flush();
    render(<AgentsCue threadId="root" />);
    expect(button()).toBeNull();
  });

  it("opens the panel on Agents, follows its section, and closes it on the second click", async () => {
    render(<AgentsCue threadId="root" />);
    await flush();
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button()!);
    expect(rightPanel.get("root")).toMatchObject({ open: true, section: "agents" });
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    act(() => rightPanel.open("root", "changes"));
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button()!);
    expect(rightPanel.get("root").section).toBe("agents");
    fireEvent.click(button()!);
    expect(rightPanel.get("root").open).toBe(false);
  });

  it("leaves at once when the last agent settles", async () => {
    render(<AgentsCue threadId="root" />);
    await flush();
    expect(button()).not.toBeNull();
    link.push({ push: "session", session: wireMeta("kid", { parentId: "root", status: "idle" }) });
    await flush();
    expect(button()).toBeNull();
  });

  it("shows nothing on a subagent's tab", async () => {
    link.push({ push: "session", session: wireMeta("grand", { parentId: "kid", status: "running" }) });
    await flush();
    render(<AgentsCue threadId="kid" />);
    expect(button()).toBeNull();
  });
});
