// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const copyText = vi.fn((_: string) => Promise.resolve());
vi.mock("../../lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));

import { TurnDuration, TurnEnd } from "./TurnEnd";

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
