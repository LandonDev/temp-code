// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { newSession, type Block } from "../session";
import { sessionStore, useSessionChrome } from "./store";

afterEach(() => {
  cleanup();
  act(() => sessionStore.mutate([]));
});

describe("useSessionChrome", () => {
  it("renders once for streamed text and again for anything else", () => {
    const user: Block = { id: "u", role: "user", text: "Go" };
    const answer = (text: string): Block => ({ id: "a", role: "assistant", text });
    const base = { ...newSession("local", "claude", "/repo"), id: "s1", status: "running" as const, blocks: [user, answer("H")] };
    act(() => sessionStore.mutate([base]));
    let renders = 0;
    const Probe = () => {
      renders += 1;
      return <span>{useSessionChrome("s1")?.status}</span>;
    };
    const { container } = render(<Probe />);
    const first = renders;
    for (const text of ["He", "Hel", "Hello"]) {
      act(() => sessionStore.mutate((prev) => prev.map((s) => ({ ...s, blocks: [user, answer(text)] }))));
    }
    expect(renders).toBe(first);
    act(() => sessionStore.mutate((prev) => prev.map((s) => ({ ...s, status: "idle" as const }))));
    expect(renders).toBe(first + 1);
    expect(container.textContent).toBe("idle");
  });
});
