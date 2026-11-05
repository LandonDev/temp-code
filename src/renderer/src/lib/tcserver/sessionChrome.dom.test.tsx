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

describe("useSessionMetaValue", () => {
  it("renders for its own value alone: a master's activity moving renders nothing, its provider does", async () => {
    const { FakeMetaLink, wireMeta } = await import("../../test/fakeMetaLink");
    const { useSessionMetaValue } = await import("./store");
    sessionStore.reset();
    const link = new FakeMetaLink();
    link.metas = [wireMeta("m", { provider: "claude", activity: "Waiting on 16 threads" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    let renders = 0;
    const provider = (meta: { provider: string }) => meta.provider;
    const Probe = () => {
      renders += 1;
      return <span>{useSessionMetaValue("m", provider)}</span>;
    };
    const { container } = render(<Probe />);
    expect(container.textContent).toBe("claude");
    const first = renders;
    for (let i = 0; i < 10; i++) link.push({ push: "session", session: wireMeta("m", { provider: "claude", activity: `Waiting on ${i} threads`, lastEventAt: i }) });
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(renders).toBe(first);
    link.push({ push: "session", session: wireMeta("m", { provider: "codex", activity: "Waiting on 1 thread" }) });
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(container.textContent).toBe("codex");
    expect(renders).toBe(first + 1);
    sessionStore.reset();
  });
});
