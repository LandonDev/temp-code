// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyText = vi.fn((_: string) => Promise.resolve());
vi.mock("../../lib/clipboard", () => ({ COPIED_MS: 1200, copyText: (text: string) => copyText(text) }));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));

import { TurnDuration, TurnEnd, WatchingLine } from "./TurnEnd";
import { PaneVisibilityContext } from "../../hooks/paneVisibility";
import { TurnStateContext, type TurnSession } from "../turnState";
import type { Block } from "../../lib/session";
import { TranscriptSessionContext } from "../transcriptSession";
import { ErrorRowView } from "./NoticeRow";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";

const agentMeta = (id: string, title: string): SessionMeta =>
  ({ id, parentId: "p", provider: "claude", model: "claude-sonnet-5-5", permission: "edits", title, cwd: "/repo",
    environmentId: "local", archived: false, status: "running", createdAt: 0 }) as unknown as SessionMeta;

afterEach(() => {
  cleanup();
  copyText.mockClear();
});

const settled = () =>
  render(
    <TurnDuration
      elapsedMs={124_000}
      done
      copyText="The answer."
      onSaveNote={() => {}}
      fromHarness="claude"
      onHandoff={() => {}}
      onSecondOpinion={() => {}}
    />,
  );

describe("TurnDuration", () => {
  it("a settled turn says what it took and nothing else", () => {
    const view = settled();
    const line = view.container.firstElementChild as HTMLElement;
    expect(line.textContent).toBe("Worked for 2m 4s");
    expect(line.textContent).not.toMatch(/\d:\d\d/);
    expect(line.textContent).not.toMatch(/[·•|]/);
  });

  it("its four actions are named and sit in the hover group", () => {
    const view = settled();
    const group = view.container.querySelector(".group-hover\\/turnend\\:opacity-100") as HTMLElement;
    for (const name of ["Copy response", "Save as note", "Hand off", "Second opinion"]) {
      const button = screen.getByRole("button", { name });
      expect(group.contains(button)).toBe(true);
    }
  });

  it("copy writes the turn's text", async () => {
    settled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    });
    expect(copyText).toHaveBeenCalledWith("The answer.");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("the live states speak StatusMark's words", () => {
    const working = render(<TurnDuration elapsedMs={12_000} live />);
    expect(working.container.textContent).toBe("Working12s");
    expect(working.container.querySelector('[data-state="working"]')).not.toBeNull();
    working.unmount();
    const waiting = render(<TurnDuration elapsedMs={12_000} live waiting />);
    expect(waiting.container.textContent).toBe("Needs you");
    waiting.unmount();
    const paused = render(<TurnDuration elapsedMs={63_000} live paused />);
    expect(paused.container.textContent).toBe("Pausedworked 1m 3s");
    expect(paused.container.querySelector('[data-state="paused"]')).not.toBeNull();
    // The word matches the age beside it: 13px, like the Stopped mark.
    expect(paused.container.querySelector('[data-state="paused"]')!.closest("[class*='text-[13px]']")).not.toBeNull();
  });
});

describe("TurnEnd of a paused turn", () => {
  it("says Paused with the frozen time, never Worked for, and no working line", () => {
    const user = { id: "u", role: "user" as const, text: "go", startedAt: 10, durationMs: 1000 };
    const state = { status: "paused", busy: false, frozenActiveElapsed: 63_000, blocks: [user] } as unknown as TurnSession;
    const { container } = render(
      <TurnStateContext.Provider value={state}>
        <TurnEnd
          turn={{ id: "t", index: 0, isLast: true, settled: false, blocks: [user], userBlock: user, durationMs: 1000, startedAt: 10 }}
          harnessOf={() => undefined}
          turnState={state}
        />
      </TurnStateContext.Provider>,
    );
    expect(container.textContent).not.toMatch(/Worked for/);
    expect(container.querySelector('[data-slot="turn-line"]')).toBeNull();
    expect(container.querySelector('[data-state="paused"]')).not.toBeNull();
  });
});

describe("TurnEnd of a queued turn", () => {
  it("draws no closing line and no working line before the turn ran: the strip says Queued", () => {
    const user = { id: "u", role: "user" as const, text: "go", startedAt: 10, durationMs: 1000 };
    const state = { status: "queued", busy: false, blocks: [user] } as unknown as TurnSession;
    const { container } = render(
      <TurnStateContext.Provider value={state}>
        <TurnEnd
          turn={{ id: "t", index: 0, isLast: true, settled: false, blocks: [user], userBlock: user, durationMs: 1000, startedAt: 10 }}
          harnessOf={() => undefined}
          turnState={state}
          liveState={false}
        />
      </TurnStateContext.Provider>,
    );
    expect(container.textContent).not.toMatch(/Worked for/);
    expect(container.querySelector('[data-slot="turn-line"]')).toBeNull();
  });

  it("where no strip says it (the fleet's agent detail), the live row says Queued, not Working", () => {
    const user = { id: "u", role: "user" as const, text: "go" };
    const state = { status: "queued", busy: false, blocks: [user] } as unknown as TurnSession;
    const { container } = render(
      <TurnStateContext.Provider value={state}>
        <TurnEnd
          turn={{ id: "t", index: 0, isLast: true, settled: false, blocks: [user], userBlock: user, durationMs: undefined, startedAt: undefined }}
          harnessOf={() => undefined}
          turnState={state}
        />
      </TurnStateContext.Provider>,
    );
    expect(container.querySelector('[data-state="queued"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/Working/);
  });
});

describe("TurnEnd's live state", () => {
  const user = { id: "u", role: "user" as const, text: "go" };
  const reply = { id: "a", role: "assistant" as const, text: "on it" };
  const state = { status: "running", busy: true, busySince: Date.now() - 5_000, blocks: [user, reply] } as unknown as TurnSession;
  const live = (liveState?: boolean) =>
    render(
      <TurnStateContext.Provider value={state}>
        <TurnEnd
          turn={{ id: "t", index: 0, isLast: true, settled: false, blocks: [user, reply], userBlock: user, durationMs: undefined, startedAt: undefined }}
          harnessOf={() => undefined}
          turnState={state}
          liveState={liveState}
        />
      </TurnStateContext.Provider>,
    );

  it("draws Working by default, for a surface with no strip (the fleet's detail)", () => {
    expect(live().container.querySelector('[data-state="working"]')).not.toBeNull();
  });

  it("draws only the working line where liveState is off: the timer above the composer runs instead", () => {
    const { container } = live(false);
    expect(container.querySelector('[data-state="working"]')).toBeNull();
    expect(container.querySelector('[data-slot="turn-line"] [role="status"]')?.getAttribute("aria-label")).toBe("Thinking");
    expect(container.textContent).not.toMatch(/\d+s/);
  });
});

describe("TurnEnd's lines through their changes, never remounted", () => {
  const user = { id: "u", role: "user" as const, text: "go" };
  const reply = { id: "a", role: "assistant" as const, text: "on it" };
  const turnOf = (blocks: Block[], settled: boolean) => ({ id: "t", index: 0, isLast: true, settled, blocks, userBlock: user, durationMs: settled ? 2_000 : undefined, startedAt: undefined });
  const draw = (session: TurnSession, settled = false) => (
    <TurnStateContext.Provider value={session}>
      <TurnEnd turn={turnOf(session.blocks as Block[], settled)} harnessOf={() => undefined} turnState={session} onOpenActivity={() => {}} />
    </TurnStateContext.Provider>
  );
  /** The live state's line (the fleet's agent detail), not the working line. */
  const liveLine = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="status"]')].find((el) => !el.closest('[data-slot="turn-line"]') && el.querySelector('[data-slot="status-mark"]'));

  it("keeps the live state's one line from working to waiting to paused, and folds it at the settle", () => {
    const running = { status: "running", busy: true, busySince: Date.now() - 5_000, blocks: [user, reply] } as unknown as TurnSession;
    const view = render(draw(running));
    const line = liveLine(view.container)!;
    const box = line.querySelector('[data-slot="status-glyph"]');
    expect(line.getAttribute("aria-label")).toBe("Working");
    const asking = { id: "b", role: "tool" as const, text: "Bash", tool: { callId: "b", name: "Bash", status: "pending", input: {} }, approval: { requestId: 1 } };
    view.rerender(draw({ ...running, blocks: [user, reply, asking] } as unknown as TurnSession));
    expect(liveLine(view.container)).toBe(line);
    expect(line.getAttribute("aria-label")).toBe("Needs you");
    view.rerender(draw({ ...running, status: "paused", busy: false } as unknown as TurnSession));
    expect(liveLine(view.container)).toBe(line);
    expect(line.getAttribute("aria-label")).toBe("Paused");
    // One glyph box through every state: the glyph cross-fades in it.
    expect(line.querySelector('[data-slot="status-glyph"]')).toBe(box);
    // The turn settles: the line folds on .collapsible-auto instead of unmounting.
    view.rerender(draw({ ...running, status: "idle", busy: false } as unknown as TurnSession, true));
    expect(line.isConnected).toBe(true);
    expect(line.closest(".collapsible-auto")).not.toBeNull();
  });

  it("opens and closes the Watching line in its fold, the same element each time", () => {
    const idle = { status: "idle", busy: false, blocks: [user, reply] } as unknown as TurnSession;
    const watching = { ...idle, status: "watching", background: { tasks: [{ id: "b1", label: "sleep 90 seconds", kind: "shell", startedAt: Date.now() }], agents: [], batch: null, watchingSince: Date.now() } } as unknown as TurnSession;
    const view = render(draw(idle, true));
    expect(view.container.textContent).not.toMatch(/Watching/);
    view.rerender(draw(watching, true));
    const line = view.container.querySelector('[data-state="watching"]')!.closest(".collapsible-auto")!;
    expect(line).not.toBeNull();
    view.rerender(draw(idle, true));
    expect(line.isConnected).toBe(true);
    view.rerender(draw(watching, true));
    expect(view.container.querySelector('[data-state="watching"]')!.closest(".collapsible-auto")).toBe(line);
  });
});

describe("TurnEnd of a watching thread", () => {
  // The fixture and render share a clock even when collection takes seconds.
  const now = Date.now();
  beforeEach(() => {
    vi.useFakeTimers({ now });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const user = { id: "u", role: "user" as const, text: "go" };
  const reply = { id: "a", role: "assistant" as const, text: "started it" };
  const settledTurn = { id: "t", index: 0, isLast: true, settled: true, blocks: [user, reply], userBlock: user, durationMs: 2_000, startedAt: 10 };
  const end = (state: TurnSession, liveState?: boolean, onOpenActivity?: () => void) =>
    render(
      <TurnStateContext.Provider value={state}>
        <TurnEnd turn={settledTurn} harnessOf={() => undefined} turnState={state} liveState={liveState} onOpenActivity={onOpenActivity} />
      </TurnStateContext.Provider>,
    );
  const watching = {
    status: "watching",
    busy: false,
    blocks: [user, reply],
    background: {
      tasks: [{ id: "b1", label: "sleep 90 seconds", kind: "shell", startedAt: now - 5 * 60_000 }],
      agents: [],
      batch: null,
      watchingSince: now - 5 * 60_000,
    },
  } as unknown as TurnSession;

  it("draws Worked for, then Watching with its age, as a live status row", () => {
    const { container } = end(watching);
    expect(container.textContent).toMatch(/^Worked for 2s/);
    const row = container.querySelector('[role="status"]')!;
    expect(row.getAttribute("aria-label")).toBe("Watching: sleep 90 seconds");
    expect(row.querySelector('[data-state="watching"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="status-detail"]')?.textContent).toBe("sleep 90 seconds");
    expect(row.textContent).toMatch(/^Watchingsleep 90 seconds5m( \d+s)?$/);
    expect(container.textContent?.indexOf("Worked for")).toBeLessThan(container.textContent!.indexOf("Watching"));
  });

  it("reads an idle parent with a live subagent as watching, with no age", () => {
    const parent = { status: "idle", busy: false, blocks: [user, reply], background: { tasks: [], agents: ["c1"], watchingSince: null } } as unknown as TurnSession;
    const row = end(parent).container.querySelector('[role="status"]')!;
    expect(row.textContent).toBe("Watchinga subagent");
  });

  it("names the one subagent it watches by title, several counted", () => {
    sessionStore.injectPush({ push: "session", session: agentMeta("c1", "Review the perf pass") }, "local");
    const one = { status: "idle", busy: false, blocks: [user, reply], background: { tasks: [], agents: ["c1"], watchingSince: null } } as unknown as TurnSession;
    expect(end(one).container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Watching: Review the perf pass");
    const three = { ...one, background: { tasks: [], agents: ["c1", "c2", "c3"], watchingSince: null } } as unknown as TurnSession;
    expect(end(three).container.querySelector('[role="status"]')!.textContent).toBe("Watching3 subagents");
    sessionStore.reset();
  });

  it("draws the watching line on a pane too, whose timer slot above the composer stays empty", () => {
    const row = end(watching, false).container.querySelector('[role="status"]')!;
    expect(row.textContent).toMatch(/^Watchingsleep 90 seconds5m( \d+s)?$/);
    expect(row.querySelector("button")).toBeNull();
  });

  it("with onOpenActivity the line is a button that opens the Activity section", () => {
    const open = vi.fn();
    const row = end(watching, false, open).container.querySelector('[role="status"]')!;
    const button = row.querySelector("button")!;
    expect(button.textContent).toMatch(/^Watchingsleep 90 seconds5m( \d+s)?$/);
    expect(button.getAttribute("aria-label")).toBe("Watching: sleep 90 seconds, open Activity");
    // A long subject truncates inside the button instead of pushing the age off the line.
    expect(button.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "shrink"]));
    expect(button.className.split(" ")).not.toContain("shrink-0");
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("turns the age amber past STALE_WATCH_MS, its own tasks alone", () => {
    const since = Date.now() - 45 * 60_000;
    const stale = { ...watching, background: { ...watching.background!, watchingSince: since } } as TurnSession;
    const age = end(stale, false).container.querySelector(".text-warning");
    expect(age?.textContent).toBe("45m");
    const fresh = end(watching, false).container.querySelectorAll(".text-warning");
    expect(fresh).toHaveLength(0);
  });

  it("keeps an old wait on live subagents quiet", () => {
    const since = Date.now() - 45 * 60_000;
    const withAgents = { ...watching, background: { ...watching.background!, agents: ["c1"], watchingSince: since } } as TurnSession;
    expect(end(withAgents, false).container.querySelector(".text-warning")).toBeNull();
  });

  it("draws none for an idle settled turn", () => {
    const idle = { status: "idle", busy: false, blocks: [user, reply] } as unknown as TurnSession;
    const { container } = end(idle);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toBe("Worked for 2s");
  });
});

describe("the Watching line's age", () => {
  // A whole second, so the clock's ticks land on the test's steps.
  const t = 1_700_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers({ now: t });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const age = (c: HTMLElement) => c.querySelector('[role="status"] [aria-hidden="true"]:not([data-slot])')?.textContent;

  it("ticks every second, never a half minute at a time", () => {
    const { container } = render(<WatchingLine since={t - (5 * 60_000 + 15_000)} subject="3 subagents" />);
    expect(age(container)).toBe("5m 15s");
    act(() => vi.advanceTimersByTime(1_000));
    expect(age(container)).toBe("5m 16s");
    act(() => vi.advanceTimersByTime(29_000));
    expect(age(container)).toBe("5m 45s");
  });

  it("holds still in a hidden pane", () => {
    const { container } = render(
      <PaneVisibilityContext.Provider value={false}>
        <WatchingLine since={t - 60_000} />
      </PaneVisibilityContext.Provider>,
    );
    const before = container.textContent;
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.textContent).toBe(before);
  });
});

describe("TurnEnd of a stopped turn", () => {
  const user = { id: "u", role: "user" as const, text: "go", startedAt: 10, durationMs: 1_000 };
  const reply = { id: "a", role: "assistant" as const, text: "half an answer" };
  const stop = { id: "err:1", role: "system" as const, text: "Stopped", stopped: true };
  const blocks = [user, reply, stop];
  const state = { status: "idle", busy: false, blocks, thread: undefined } as unknown as TurnSession;
  const stoppedTurn = { id: "t", index: 0, isLast: true, settled: true, blocks, userBlock: user, durationMs: 1_000, startedAt: 10 };
  const view = () =>
    render(
      <TranscriptSessionContext.Provider value="s1">
        <TurnStateContext.Provider value={state}>
          <ErrorRowView block={stop} />
          <TurnEnd
            turn={stoppedTurn}
            harnessOf={() => "claude"}
            turnState={state}
            onSaveNote={() => {}}
            onHandoff={() => {}}
            onSecondOpinion={() => {}}
          />
        </TurnStateContext.Provider>
      </TranscriptSessionContext.Provider>,
    );

  it("closes on Stopped, said once, with no Worked for", () => {
    const { container } = view();
    expect(container.textContent).toBe("Stopped");
    expect(container.querySelectorAll('[data-state="stopped"]')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/Worked/);
  });

  it("carries the four actions, reachable by keyboard focus", () => {
    const { container } = view();
    const group = container.querySelector(".group-hover\\/turnend\\:opacity-100") as HTMLElement;
    // Keyboard focus shows them at once and an open menu keeps them; a mouse
    // click that leaves Copy focused does not hold them on screen.
    expect(group.className).toContain("has-focus-visible:opacity-100");
    expect(group.className).toContain("has-aria-expanded:opacity-100");
    expect(group.className).not.toContain("focus-within:");
    // A pointer crossing the row does not flash them: hover waits, focus does not.
    expect(group.className).toContain("group-hover/turnend:delay-(--delay-hover)");
    expect(group.className).toContain("has-focus-visible:delay-(--dur-instant)");
    for (const name of ["Copy response", "Save as note", "Hand off", "Second opinion"]) {
      const button = screen.getByRole("button", { name });
      expect(group.contains(button)).toBe(true);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it("a completed turn keeps Worked for", () => {
    const done = { ...stoppedTurn, blocks: [user, reply] };
    const { container } = render(<TurnEnd turn={done} harnessOf={() => undefined} turnState={{ ...state, blocks: [user, reply] }} />);
    expect(container.textContent).toBe("Worked for 1s");
  });

  it("a stopped turn still open says Stopped once, on its closing line, at once: the stop row draws nothing", () => {
    const busy = { ...state, status: "running", busy: true } as unknown as TurnSession;
    const { container } = render(
      <TranscriptSessionContext.Provider value="s1">
        <TurnStateContext.Provider value={busy}>
          <ErrorRowView block={stop} />
          <TurnEnd turn={{ ...stoppedTurn, settled: false }} harnessOf={() => undefined} turnState={busy} liveState={false} />
        </TurnStateContext.Provider>
      </TranscriptSessionContext.Provider>,
    );
    expect(container.textContent).toBe("Stopped");
    expect(container.querySelectorAll('[data-state="stopped"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="turn-line"] [data-state="stopped"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="working-mark"]')).toBeNull();
  });
});

describe("TurnEnd while the turn waits on its agents", () => {
  const user = { id: "u", role: "user" as const, text: "go" };
  const reply = { id: "a", role: "assistant" as const, text: "Spawning the review." };
  const wait = (input: unknown) => ({
    id: "w",
    role: "tool" as const,
    text: "wait",
    tool: { callId: "w", name: "mcp__orchestrator__wait_for_agent", input, status: "running" },
  });
  const live = (blocks: unknown[]) => {
    const state = { status: "running", busy: true, busySince: Date.now() - 5_000, blocks } as unknown as TurnSession;
    const turn = { id: "t", index: 0, isLast: true, settled: false, blocks, userBlock: user, durationMs: undefined, startedAt: undefined };
    return render(
      <TurnStateContext.Provider value={state}>
        <TurnEnd turn={turn as never} harnessOf={() => undefined} turnState={state} liveState={false} />
      </TurnStateContext.Provider>,
    );
  };
  /** The working line's words, as its status names them. */
  const said = (c: HTMLElement) => c.querySelector('[data-slot="turn-line"] [role="status"]')?.getAttribute("aria-label");
  afterEach(() => sessionStore.reset());

  it("says Waiting on a subagent until the title lands, then names it", async () => {
    const view = live([user, reply, wait({ agentId: "c1" })]);
    expect(said(view.container)).toBe("Waiting on a subagent");
    await act(async () => {
      sessionStore.injectPush({ push: "session", session: agentMeta("c1", "Review the perf pass") }, "local");
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(said(view.container)).toBe("Waiting on Review the perf pass");
    // Drawn like a call: the verb muted, the agent's title the bright text on its line.
    expect(view.container.querySelector('[data-slot="turn-line"] [data-slot="working-text"] .text-foreground')?.textContent).toBe(
      "Review the perf pass",
    );
  });

  it("counts several agents", () => {
    const view = live([user, reply, wait({ agentIds: ["c1", "c2"] })]);
    expect(said(view.container)).toBe("Waiting on 2 subagents");
    expect(view.container.querySelector('[data-slot="turn-line"] [data-slot="working-text"] .text-foreground')?.textContent).toBe("2 subagents");
  });

  it("stops saying the wait once prose follows it", () => {
    const view = live([user, wait({ agentId: "c1" }), { id: "p", role: "assistant", text: "Meanwhile I read the docs." }]);
    expect(said(view.container)).toBe("Thinking");
  });
});

describe("SaveNoteButton", () => {
  it("reverts to Save as note on COPIED_MS, as Copy does", async () => {
    vi.useFakeTimers();
    try {
      const { SaveNoteButton } = await import("./TurnEnd");
      const onSave = vi.fn();
      render(<SaveNoteButton text="The answer" onSave={onSave} />);
      fireEvent.click(screen.getByRole("button", { name: "Save as note" }));
      expect(onSave).toHaveBeenCalledWith("The answer");
      expect(screen.getByRole("button", { name: "Saved to Notes" })).toBeTruthy();
      // The mocked clipboard's COPIED_MS is 1200: still saved just before it, back just after.
      act(() => vi.advanceTimersByTime(1199));
      expect(screen.getByRole("button", { name: "Saved to Notes" })).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("button", { name: "Save as note" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
