// @vitest-environment jsdom
import { Profiler, useState } from "react";
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
    // Mount: the strip lands first, the transcript in the next commit.
    expect(commits).toEqual([
      { strip: "a", transcript: null },
      { strip: "a", transcript: "a" },
    ]);
    commits.length = 0;
    await act(async () => switchTo("b"));
    expect(commits).toEqual([
      { strip: "b", transcript: null },
      { strip: "b", transcript: "b" },
    ]);
    expect(container.querySelector("[data-body-empty]")).toBeNull();
  });
});
