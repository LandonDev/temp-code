import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineChunk, preloadWhenIdle } from "./lazyChunk";

type Mod = { Thing: (props: { label: string }) => React.JSX.Element };

/** A chunk whose import settles when the test says so. */
function controlled() {
  let resolve!: (m: Mod) => void;
  let reject!: (e: unknown) => void;
  const calls = { n: 0 };
  const chunk = defineChunk<Mod>("test", () => {
    calls.n += 1;
    return new Promise<Mod>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });
  const mod: Mod = { Thing: ({ label }) => <div data-thing>{label}</div> };
  return { chunk, calls, mod, resolve: () => resolve(mod), reject: (e: unknown) => reject(e) };
}

const tick = () => act(async () => {});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("defineChunk", () => {
  it("renders the fallback until the chunk lands, then the surface", async () => {
    const { chunk, resolve, calls } = controlled();
    const Thing = chunk.surface("Thing", <div data-fallback />);
    const { container } = render(<Thing label="one" />);
    expect(container.querySelector("[data-fallback]")).not.toBeNull();
    expect(container.querySelector("[data-thing]")).toBeNull();
    expect(calls.n).toBe(1);
    await act(async () => resolve());
    await tick();
    expect(container.querySelector("[data-fallback]")).toBeNull();
    expect(container.querySelector("[data-thing]")?.textContent).toBe("one");
    expect(chunk.loaded()).not.toBeNull();
  });

  it("a preloaded chunk mounts its surface in the first commit, with no fallback", async () => {
    const { chunk, resolve } = controlled();
    chunk.preload();
    await act(async () => resolve());
    await tick();
    const commits: boolean[] = [];
    const Thing = chunk.surface("Thing", <div data-fallback />);
    const container = document.body.appendChild(document.createElement("div"));
    render(
      <React.Profiler id="p" onRender={() => commits.push(container.querySelector("[data-fallback]") !== null)}>
        <Thing label="warm" />
      </React.Profiler>,
      { container },
    );
    expect(container.querySelector("[data-thing]")?.textContent).toBe("warm");
    expect(commits).toEqual([false]);
  });

  it("intent handlers and preload start the import once", () => {
    const { chunk, calls } = controlled();
    expect(chunk.started()).toBe(false);
    chunk.intent.onPointerEnter();
    chunk.intent.onFocus();
    chunk.preload();
    void chunk.load();
    expect(calls.n).toBe(1);
    expect(chunk.started()).toBe(true);
    expect(chunk.loaded()).toBeNull();
  });

  it("the same surface is one component however often it is asked for", () => {
    const { chunk } = controlled();
    expect(chunk.surface("Thing")).toBe(chunk.surface("Thing"));
  });

  it("a failed import is retried by the next load", async () => {
    const { chunk, calls, reject } = controlled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = chunk.load();
    reject(new Error("chunk missing"));
    await expect(first).rejects.toThrow("chunk missing");
    expect(chunk.started()).toBe(false);
    chunk.preload();
    expect(calls.n).toBe(2);
  });
});

describe("a surface that fails", () => {
  it("a failed import shows the fallback with Retry; Retry calls the loader again and mounts the component", async () => {
    const { chunk, calls, reject, resolve } = controlled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Thing = chunk.surface("Thing", <div data-fallback data-surface-skeleton="pane" />);
    const { container } = render(<Thing label="back" />);
    await act(async () => reject(new Error("chunk missing")));
    await tick();
    expect(container.querySelector("[data-fallback]")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load");
    expect(calls.n).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await tick();
    expect(calls.n).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => resolve());
    await tick();
    expect(container.querySelector("[data-thing]")?.textContent).toBe("back");
    expect(container.querySelector("[data-fallback]")).toBeNull();
  });

  it("a later mount of a failed surface asks the loader again instead of rethrowing the old failure", async () => {
    const { chunk, calls, reject, resolve } = controlled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Thing = chunk.surface("Thing", <div data-fallback />);
    const first = render(<Thing label="a" />);
    await act(async () => reject(new Error("chunk missing")));
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    first.unmount();
    expect(calls.n).toBe(2);
    await act(async () => resolve());
    const second = render(<Thing label="b" />);
    await tick();
    expect(second.container.querySelector("[data-thing]")?.textContent).toBe("b");
  });

  it("the rail beside a failed surface stays mounted", async () => {
    const { chunk, reject } = controlled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Thing = chunk.surface("Thing", <div data-fallback />);
    const { container } = render(
      <div>
        <nav data-rail>rail</nav>
        <Thing label="x" />
      </div>,
    );
    await act(async () => reject(new Error("chunk missing")));
    await tick();
    expect(container.querySelector("[data-rail]")?.textContent).toBe("rail");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a surface that throws while rendering is held in its own boundary too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): React.JSX.Element => {
      throw new Error("render broke");
    };
    const chunk = defineChunk("boom", async () => ({ Boom }));
    const Surface = chunk.surface("Boom", <div data-fallback />);
    const { container } = render(
      <div>
        <nav data-rail>rail</nav>
        <Surface />
      </div>,
    );
    await tick();
    await tick();
    expect(container.querySelector("[data-rail]")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load");
  });
});

describe("preloadWhenIdle", () => {
  it("preloads in an idle callback and not twice", () => {
    const { chunk, calls } = controlled();
    const idle = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = idle;
    try {
      preloadWhenIdle(chunk);
      preloadWhenIdle(chunk);
      expect(idle).toHaveBeenCalledTimes(1);
      expect(calls.n).toBe(1);
    } finally {
      delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    }
  });

  it("falls back to a timer without requestIdleCallback", () => {
    vi.useFakeTimers();
    try {
      const { chunk, calls } = controlled();
      preloadWhenIdle(chunk);
      expect(calls.n).toBe(0);
      vi.advanceTimersByTime(300);
      expect(calls.n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
