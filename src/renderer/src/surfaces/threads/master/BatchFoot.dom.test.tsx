// @vitest-environment jsdom
/** A step's console stays in its fold while the fold closes. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyBatch, type BatchState } from "@server/shared/contract-batch";
// Base UI's panel unmounts its content only after its exit; jsdom runs no exit, so a stand-in
// panel that stays mounted shows what the row hands it while it closes.
vi.mock("../../../components/ui/collapsible", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../components/ui/collapsible")>();
  const { createContext, useContext } = await import("react");
  const Open = createContext(false);
  return {
    ...real,
    Collapsible: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => <Open.Provider value={!!open}>{children}</Open.Provider>,
    CollapsibleContent: ({ children }: { children?: React.ReactNode }) => <div data-panel={useContext(Open) ? "open" : "closed"}>{children}</div>,
  };
});

import { BatchFoot } from "./BatchFoot";

afterEach(cleanup);

const t = Date.now() - 5 * 60_000;

function failedGate(): BatchState {
  const state = emptyBatch("m");
  const [land, gate, release] = state.steps;
  return {
    ...state,
    steps: [
      { ...land, status: "passed", detail: "nothing landed", at: t, startedAt: t, endedAt: t },
      { ...gate, status: "failed", detail: "vitest: 2 failed", at: t, startedAt: t, endedAt: t + 69_000, log: ["✓ typecheck 12s", "✗ vitest 2 failed", "  src/a.test.ts"] },
      release,
    ],
  };
}

const noop = async () => {};

describe("BatchFoot", () => {
  it("keeps a step's console in its fold while the fold closes: the panel, not the row, decides when it goes", () => {
    render(<BatchFoot batch={failedGate()} titleOf={() => undefined} onSave={noop} onStop={noop} />);
    const gate = document.querySelector('[data-step="gate"]') as HTMLElement;
    expect(gate.querySelector("[data-console]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    // The stand-in panel stays mounted while closing, as Base UI's does until its exit ends:
    // what it holds is still the console's lines, never an empty box.
    const panel = gate.querySelector("[data-panel]") as HTMLElement;
    expect(panel.dataset.panel).toBe("closed");
    expect(panel.querySelector("[data-console]")?.textContent).toContain("vitest 2 failed");
  });

  it("an instant step says no time", () => {
    render(<BatchFoot batch={failedGate()} titleOf={() => undefined} onSave={noop} onStop={noop} />);
    expect(document.querySelector('[data-step="land"] [data-step-time]')).toBeNull();
    expect(document.querySelector('[data-step="gate"] [data-step-time]')?.textContent).toBe("1m 9s");
  });
  it("a running step's Stop is the word alone, its spinner in the slot BusyLabel holds while the stop runs", async () => {
    let finish: () => void = () => {};
    const onStop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const state = failedGate();
    const running: BatchState = { ...state, steps: state.steps.map((s) => (s.id === "gate" ? { ...s, status: "running", endedAt: undefined } : s)) };
    render(<BatchFoot batch={running} titleOf={() => undefined} onSave={noop} onStop={onStop} />);
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.querySelector("svg")).toBeNull();
    expect(stop.querySelector('[data-slot="busy-label"]')?.getAttribute("data-idle")).toBe("Stop");
    expect(stop.querySelector('[data-slot="busy-label"]')?.getAttribute("data-busy-text")).toBe("Stop");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledWith("gate");
    expect(stop.querySelector('[data-slot="busy-label"]')?.hasAttribute("data-busy")).toBe(true);
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(stop.querySelector('[data-slot="busy-label"]')?.hasAttribute("data-busy")).toBe(false);
  });
});
