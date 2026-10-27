// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

import { registry } from "../lib/connection";
import { sessionStore } from "../lib/tcserver/store";
import { moveThread, resetMoves, useMoveNotices } from "../lib/threadMove";
import { MoveToasts } from "./ThreadHostChip";

type Options = { id: string; duration: number; description?: string; onDismiss: () => void };

function moveAnswering(answer: () => Promise<unknown>) {
  vi.spyOn(sessionStore, "environmentOf").mockReturnValue("local");
  vi.spyOn(sessionStore, "hostIdOf").mockImplementation((id) => id);
  vi.spyOn(sessionStore, "metaOf").mockReturnValue({ title: "Fix the build" } as never);
  vi.spyOn(registry, "environment").mockImplementation((id) => ({ id, name: id === "local" ? "This Mac" : "box", routes: [], credentialRef: null }));
  vi.spyOn(registry, "linkOf").mockReturnValue({ request: answer } as never);
}

function Count() {
  return <output data-testid="n">{useMoveNotices().length}</output>;
}

afterEach(() => {
  cleanup();
  resetMoves();
  vi.restoreAllMocks();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("MoveToasts", () => {
  it("a clean move is one line that leaves on its own", async () => {
    moveAnswering(() => Promise.resolve({ dirty: [], dirtyMore: 0, branch: null }));
    render(<MoveToasts />);
    await act(() => moveThread("t", "env_box"));
    await flush();
    const [title, opts] = vi.mocked(toast).mock.calls[0] as [string, Options];
    expect(title).toBe('Moved "Fix the build" to box');
    expect(opts).toMatchObject({ id: expect.stringMatching(/^move:/), description: undefined, duration: 8_000 });
  });

  it("changes left behind are the second line, and the toast waits; dismissing it clears the notice", async () => {
    moveAnswering(() => Promise.resolve({ dirty: ["a.ts"], dirtyMore: 0, branch: null }));
    const view = render(
      <>
        <MoveToasts />
        <Count />
      </>,
    );
    await act(() => moveThread("t", "env_box"));
    await flush();
    const [title, opts] = vi.mocked(toast).mock.calls[0] as [string, Options];
    expect(title).toBe('Moved "Fix the build" to box');
    expect(opts.description).toBe("Uncommitted changes stayed on This Mac");
    expect(opts.duration).toBe(Infinity);
    expect(opts).toMatchObject({ closeButton: true });
    act(() => opts.onDismiss());
    expect(view.getByTestId("n").textContent).toBe("0");
  });

  it("a failed move is an error toast with the error's first line", async () => {
    moveAnswering(() => Promise.reject(new Error("box is not connected\nstack")));
    render(<MoveToasts />);
    await act(() => moveThread("t", "env_box").catch(() => {}));
    await flush();
    const [title, opts] = vi.mocked(toast.error).mock.calls[0] as [string, Options];
    expect(title).toBe('Couldn\'t move "Fix the build" to box');
    expect(opts.description).toBe("box is not connected");
  });
});
