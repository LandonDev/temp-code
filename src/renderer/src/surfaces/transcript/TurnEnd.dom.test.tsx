// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const copyText = vi.fn((_: string) => Promise.resolve());
vi.mock("../../lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));

import { TurnDuration, TurnEnd } from "./TurnEnd";
import { TurnStateContext, type TurnSession } from "../turnState";
import { TranscriptSessionContext } from "../transcriptSession";
import { ErrorRowView } from "./NoticeRow";

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
  });
});

describe("TurnEnd's thinking tail", () => {
  it("is the thinking row's shape: the glyph slot and a 32px row", () => {
    const user = { id: "u", role: "user" as const, text: "go" };
    const { container } = render(
      <TurnEnd
        turn={{ id: "t", index: 0, isLast: false, settled: false, blocks: [user], userBlock: user, durationMs: undefined, startedAt: undefined }}
        harnessOf={() => undefined}
        turnState={null}
      />,
    );
    const tail = container.querySelector('[data-slot="thinking-tail"]')!;
    expect(tail).not.toBeNull();
    expect(tail.className).toContain("min-h-8");
    expect(tail.className).not.toMatch(/h-\[/);
    expect(tail.querySelector("svg")).not.toBeNull();
    expect(tail.textContent).toBe("Thinking");
  });
});

describe("TurnEnd of a paused turn", () => {
  it("says Paused with the frozen time, never Worked for, and no thinking tail", () => {
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
    expect(container.querySelector('[data-slot="thinking-tail"]')).toBeNull();
    expect(container.querySelector('[data-state="paused"]')).not.toBeNull();
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

  it("draws nothing under a strip, which says it once", () => {
    expect(live(false).container.textContent).toBe("");
  });
});

describe("TurnEnd of a watching thread", () => {
  const user = { id: "u", role: "user" as const, text: "go" };
  const reply = { id: "a", role: "assistant" as const, text: "started it" };
  const settledTurn = { id: "t", index: 0, isLast: true, settled: true, blocks: [user, reply], userBlock: user, durationMs: 2_000, startedAt: 10 };
  const end = (state: TurnSession, liveState?: boolean) =>
    render(
      <TurnStateContext.Provider value={state}>
        <TurnEnd turn={settledTurn} harnessOf={() => undefined} turnState={state} liveState={liveState} />
      </TurnStateContext.Provider>,
    );
  const watching = {
    status: "watching",
    busy: false,
    blocks: [user, reply],
    background: {
      tasks: [{ id: "b1", label: "sleep 90 seconds", kind: "shell", startedAt: Date.now() - 5 * 60_000 }],
      agents: [],
      batch: null,
      watchingSince: Date.now() - 5 * 60_000,
    },
  } as unknown as TurnSession;

  it("draws Worked for, then Watching with its age, as a live status row", () => {
    const { container } = end(watching);
    expect(container.textContent).toMatch(/^Worked for 2s/);
    const row = container.querySelector('[role="status"]')!;
    expect(row.getAttribute("aria-label")).toBe("Watching");
    expect(row.querySelector('[data-state="watching"]')).not.toBeNull();
    expect(row.textContent).toBe("Watching5m");
    expect(container.textContent?.indexOf("Worked for")).toBeLessThan(container.textContent!.indexOf("Watching"));
  });

  it("reads an idle parent with a live subagent as watching, with no age", () => {
    const parent = { status: "idle", busy: false, blocks: [user, reply], background: { tasks: [], agents: ["c1"], watchingSince: null } } as unknown as TurnSession;
    const row = end(parent).container.querySelector('[role="status"]')!;
    expect(row.textContent).toBe("Watching");
  });

  it("draws no watching line under a strip", () => {
    expect(end(watching, false).container.querySelector('[role="status"]')).toBeNull();
  });

  it("draws none for an idle settled turn", () => {
    const idle = { status: "idle", busy: false, blocks: [user, reply] } as unknown as TurnSession;
    const { container } = end(idle);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toBe("Worked for 2s");
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
    expect(group.className).toContain("focus-within:opacity-100");
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

  it("a stopped turn still open keeps its Stopped row and draws no closing line", () => {
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
  });
});
