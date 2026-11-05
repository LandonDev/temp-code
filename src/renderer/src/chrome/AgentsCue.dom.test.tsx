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
import type { MarkId } from "./HarnessIcon";
import { AgentsCue, AgentsCueView } from "./AgentsCue";
import { AgentsCueEndGroup } from "./AgentsCue.preview";
import FIXTURES from "./AgentsCue.preview.fixtures";

const cue = (working: number, waiting = 0, queued = 0, rootRunning = false, providers: MarkId[] = []) =>
  agentsCue({ working, waiting, queued, providers }, rootRunning)!;
const marks = () => [...document.querySelectorAll("[data-agents-cue] [data-mark]")].map((el) => el.getAttribute("data-mark"));
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
    render(<AgentsCueView cue={cue(3, 0, 1)} pressed={false} onClick={() => {}} />);
    const el = screen.getByRole("button", { name: "Agents: 3 working, 1 queued" });
    expect(el.textContent).toBe("4 agents");
    expect(el.querySelector(".tabular-nums")?.textContent).toBe("4 agents");
  });

  it("leads with waiting's amber when one needs you, and says so in amber words", () => {
    render(<AgentsCueView cue={cue(2, 1)} pressed={false} onClick={() => {}} />);
    expect(button()!.getAttribute("data-state")).toBe("waiting");
    const mark = button()!.querySelector('[data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("waiting");
    expect(mark.className).toContain("text-warning");
    expect(button()!.textContent).toBe("1 needs you");
    expect(screen.getByText("1 needs you").closest(".text-warning")).not.toBeNull();
    expect(button()!.getAttribute("aria-label")).toBe("Agents: 1 needs you, 2 working");
  });

  it("draws one mark per distinct provider after the glyph and before the words", () => {
    render(<AgentsCueView cue={cue(3, 0, 0, false, ["claude", "codex"])} pressed={false} onClick={() => {}} />);
    expect(marks()).toEqual(["claude", "codex"]);
    const kids = [...button()!.children].map((el) => el.getAttribute("data-slot") ?? el.textContent);
    expect(kids[0]).toBe("status-mark");
    expect(kids[1]).toBe("cue-marks");
    expect(button()!.textContent).toBe("3 agents");
    expect(button()!.getAttribute("aria-label")).toBe("Agents: 3 working on Claude Code and Codex");
    expect(button()!.querySelector('[data-slot="cue-marks"]')!.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws no mark row when no provider is known", () => {
    render(<AgentsCueView cue={cue(2)} pressed={false} onClick={() => {}} />);
    expect(button()!.querySelector('[data-slot="cue-marks"]')).toBeNull();
  });

  it("draws a Muse Code agent with Meta's symbol, once beside a Meta model, and names both", () => {
    render(<AgentsCueView cue={cue(2, 0, 0, false, ["muse", "meta"])} pressed={false} onClick={() => {}} />);
    expect(marks()).toEqual(["muse"]);
    expect(button()!.querySelector('[data-mark="muse"] svg path')!.getAttribute("d")).toMatch(/^M6\.915 4\.03/);
    expect(button()!.getAttribute("aria-label")).toBe("Agents: 2 working on Muse Code and Meta");
  });

  it("caps the marks at four and counts the rest as +N", () => {
    render(<AgentsCueView cue={cue(6, 0, 0, false, ["claude", "codex", "muse", "cursor", "grok", "pi"])} pressed={false} onClick={() => {}} />);
    expect(marks()).toEqual(["claude", "codex", "muse", "cursor"]);
    expect(button()!.querySelector('[data-slot="cue-marks"]')!.textContent).toBe("+2");
    expect(button()!.textContent).toBe("+26 agents");
  });

  it("keeps the control and its marks when the count or the providers change", () => {
    const view = render(<AgentsCueView cue={cue(1, 0, 0, false, ["claude"])} pressed={false} onClick={() => {}} />);
    const el = button()!;
    const claude = el.querySelector('[data-mark="claude"]');
    view.rerender(<AgentsCueView cue={cue(3, 0, 0, false, ["claude", "codex"])} pressed={false} onClick={() => {}} />);
    expect(button()).toBe(el);
    expect(el.querySelector('[data-mark="claude"]')).toBe(claude);
    expect(el.querySelector('[data-mark="codex"]')).not.toBeNull();
  });

  it("is a quiet 24px row control: 12px muted words and the /5 hover fill", () => {
    render(<AgentsCueView cue={cue(1)} pressed={false} onClick={() => {}} />);
    const cls = button()!.className;
    expect(cls).toContain("h-6");
    expect(cls).toContain("px-2");
    // A glyph sits 8px from the first word, as on the plan chip beside it.
    expect(cls.split(/\s+/)).toContain("gap-2");
    expect(cls.split(/\s+/)).not.toContain("gap-1.5");
    expect(cls).toContain("text-xs");
    expect(cls).toContain("text-muted-foreground");
    expect(cls).toContain("hover:bg-foreground/5");
    expect(cls).not.toContain("hover:bg-foreground/7");
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

  it("fades in on entry on a wrapper and carries the pressed fill", () => {
    render(<AgentsCueView cue={cue(1)} pressed onClick={() => {}} />);
    const fade = button()!.parentElement!.className;
    expect(fade).toContain("starting:opacity-0");
    expect(fade).toContain("duration-(--dur-fast)");
    expect(fade).toContain("motion-reduce:transition-opacity");
    // The fade rides the wrapper, so the button keeps its hover fill on --dur-hover.
    const cls = button()!.className;
    expect(cls).not.toContain("transition-opacity");
    expect(cls).not.toContain("starting:opacity-0");
    // Pressed as Toggle is (muted, foreground text), and pressed down to /12 as every row is.
    expect(cls).toContain("aria-pressed:bg-muted");
    expect(cls).not.toContain("aria-pressed:bg-foreground/7");
    expect(cls).toContain("active:bg-foreground/12");
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

  it("reads pressed when the open panel shows Agents by default, and a click then closes it", async () => {
    // Opened by the panel toggle: no section asked for; the panel draws its default and says so.
    act(() => {
      rightPanel.open("root");
      rightPanel.setShown("root", "agents");
    });
    render(<AgentsCue threadId="root" />);
    await flush();
    expect(rightPanel.get("root").section).toBeNull();
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button()!);
    expect(rightPanel.get("root").open).toBe(false);
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("reads what the panel draws over what was asked: Agents by name, and not pressed while it draws another", async () => {
    act(() => {
      rightPanel.open("root", "agents");
      rightPanel.setShown("root", "agents");
    });
    render(<AgentsCue threadId="root" />);
    await flush();
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    // A remembered section the panel can't draw falls back to Agents: still pressed.
    act(() => {
      rightPanel.set("root", { section: "files" });
      rightPanel.setShown("root", "agents");
    });
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    act(() => rightPanel.setShown("root", "notes"));
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
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
