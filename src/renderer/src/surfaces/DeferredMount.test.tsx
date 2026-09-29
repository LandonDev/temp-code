// @vitest-environment jsdom
import { Profiler, useState, useSyncExternalStore } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeferredMount } from "./DeferredMount";

/** A strip that switches sessions and a body that mounts the transcript. */
function Shell({ onSwitch }: { onSwitch: (fn: (id: string) => void) => void }) {
  const [id, setId] = useState("a");
  onSwitch(setId);
  return (
    <>
      <div data-strip>{id}</div>
      <DeferredMount key={id} fallback={<div data-body-empty />}>
        <div data-transcript>{id}</div>
      </DeferredMount>
    </>
  );
}

/** One animation frame, inside act so the flip's state update is flushed. */
const frame = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

describe("DeferredMount", () => {
  it("switching commits the strip before the transcript", async () => {
    let switchTo: (id: string) => void = () => {};
    const commits: { strip: string | null; transcript: string | null }[] = [];
    const container = document.createElement("div");
    render(
      <Profiler
        id="shell"
        onRender={() =>
          commits.push({
            strip: container.querySelector("[data-strip]")?.textContent ?? null,
            transcript: container.querySelector("[data-transcript]")?.textContent ?? null,
          })
        }
      >
        <Shell onSwitch={(fn) => (switchTo = fn)} />
      </Profiler>,
      { container: document.body.appendChild(container) },
    );
    // Mount: the strip lands first, the transcript in the next frame.
    expect(commits).toEqual([{ strip: "a", transcript: null }]);
    await frame();
    expect(commits).toEqual([
      { strip: "a", transcript: null },
      { strip: "a", transcript: "a" },
    ]);
    commits.length = 0;
    await act(async () => switchTo("b"));
    expect(commits).toEqual([{ strip: "b", transcript: null }]);
    await frame();
    expect(commits).toEqual([
      { strip: "b", transcript: null },
      { strip: "b", transcript: "b" },
    ]);
    expect(container.querySelector("[data-body-empty]")).toBeNull();
  });

  it("a store that notifies synchronously every frame cannot hold the transcript back", async () => {
    // A stand-in for the session store: a sync-lane update per frame, the
    // way meta pushes and event flushes land while a fleet runs.
    let version = 0;
    const listeners = new Set<() => void>();
    const store = {
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      get: () => version,
      bump: () => {
        version += 1;
        for (const l of listeners) l();
      },
    };
    function Busy() {
      const v = useSyncExternalStore(store.subscribe, store.get);
      return (
        <>
          <div data-version>{v}</div>
          <DeferredMount fallback={<div data-body-empty />}>
            <div data-transcript>ready</div>
          </DeferredMount>
        </>
      );
    }
    const container = document.createElement("div");
    render(<Busy />, { container: document.body.appendChild(container) });
    expect(container.querySelector("[data-transcript]")).toBeNull();
    let frames = 0;
    let stop = false;
    const storm = () => {
      if (stop) return;
      act(() => store.bump());
      requestAnimationFrame(storm);
    };
    storm();
    while (!container.querySelector("[data-transcript]") && frames < 2) {
      await frame();
      frames += 1;
    }
    stop = true;
    expect(container.querySelector("[data-transcript]")?.textContent).toBe("ready");
    expect(frames).toBeLessThanOrEqual(2);
    expect(Number(container.querySelector("[data-version]")?.textContent)).toBeGreaterThan(0);
  });
});
