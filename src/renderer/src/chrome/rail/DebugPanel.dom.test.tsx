// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { controller, openFileAt } = vi.hoisted(() => ({
  controller: {
    step: vi.fn(),
    stop: vi.fn(),
    evaluate: vi.fn(() => Promise.resolve()),
    loadVariables: vi.fn(() => Promise.resolve()),
  },
  openFileAt: vi.fn(),
}));
vi.mock("../../surfaces/monaco/debug/session", () => ({ debugController: () => controller }));
vi.mock("../../lib/monaco/opener", () => ({ openFileAt }));

import { getEditorState, setEditorState, type EditorState } from "../../lib/monaco/editorState";
import DebugPanel from "./DebugPanel";

const initial: EditorState = getEditorState();

beforeEach(() => setEditorState(initial));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function seed(patch: Partial<EditorState>) {
  setEditorState({
    debugFrames: [
      { id: 1, name: "Main.run", line: 42, path: "/repo/src/Main.java" },
      { id: 2, name: "Thread.run", line: 829, path: null },
    ],
    debugVariables: [
      { name: "this", value: "Main@12", ref: 7, depth: 0, frameId: 1 },
      { name: "count", value: "3", ref: null, depth: 1, frameId: 1 },
    ],
    debugOutput: ["Listening on 5005", "started"],
    ...patch,
  });
}

const control = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const field = () => screen.getByLabelText("Evaluate expression") as HTMLInputElement;

describe("DebugPanel", () => {
  it("says how to start a session when there is none", () => {
    render(<DebugPanel />);
    expect(screen.getByText("⌃D in a Java file starts a session here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByLabelText("Evaluate expression")).toBeNull();
  });

  it("keeps the step controls and the evaluate field off while the session runs", () => {
    seed({ debugPhase: "running", debugFrames: [], debugVariables: [] });
    render(<DebugPanel />);
    for (const name of ["Continue", "Step over", "Step into", "Step out"]) expect(control(name).disabled).toBe(true);
    expect(control("Stop").disabled).toBe(false);
    expect(field().disabled).toBe(true);
    expect(field().placeholder).toBe("Evaluate…");
    expect(document.querySelector("[data-slot=status-mark]")?.getAttribute("data-state")).toBe("working");
    expect(screen.getByText("Working")).toBeTruthy();
    // One group alone needs no heading.
    expect(screen.queryByText("Console")).toBeNull();
    fireEvent.click(control("Stop"));
    expect(controller.stop).toHaveBeenCalledOnce();
  });

  it("steps, lists frames and variables, and evaluates while paused", () => {
    seed({ debugPhase: "stopped" });
    render(<DebugPanel />);
    expect(document.querySelector("[data-slot=status-mark]")?.getAttribute("data-state")).toBe("paused");
    expect(screen.getByText("Paused")).toBeTruthy();
    for (const heading of ["Call stack", "Variables", "Console"]) expect(screen.getByRole("heading", { name: heading })).toBeTruthy();

    const steps: Array<[string, string]> = [
      ["Continue", "continue"],
      ["Step over", "next"],
      ["Step into", "stepIn"],
      ["Step out", "stepOut"],
    ];
    for (const [name, kind] of steps) {
      expect(control(name).disabled).toBe(false);
      fireEvent.click(control(name));
      expect(controller.step).toHaveBeenLastCalledWith(kind);
    }

    // Frames: the top one is current; a pick opens its file and loads its variables.
    const top = screen.getByText("Main.run").closest("button")!;
    expect(top.getAttribute("aria-current")).toBe("true");
    expect(top.textContent).toContain("42");
    const outer = screen.getByText("Thread.run").closest("button")!;
    fireEvent.click(outer);
    expect(outer.getAttribute("aria-current")).toBe("true");
    expect(openFileAt).not.toHaveBeenCalled();
    expect(controller.loadVariables).toHaveBeenLastCalledWith(2);
    fireEvent.click(top);
    expect(openFileAt).toHaveBeenCalledWith("/repo/src/Main.java", 42, 1);

    // Variables: an expandable one loads its children one level deeper; a leaf is not a button.
    fireEvent.click(screen.getByText("this").closest("button")!);
    expect(controller.loadVariables).toHaveBeenLastCalledWith(1, 7, 1);
    expect(screen.getByText("count").closest("button")).toBeNull();
    expect((screen.getByText("count").parentElement as HTMLElement).style.paddingLeft).toBe("20px");

    expect(screen.getByText("Listening on 5005")).toBeTruthy();

    // Evaluate: trimmed, sent, cleared; blank sends nothing.
    fireEvent.change(field(), { target: { value: "  count + 1 " } });
    fireEvent.submit(field().form!);
    expect(controller.evaluate).toHaveBeenCalledWith("count + 1");
    expect(field().value).toBe("");
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.submit(field().form!);
    expect(controller.evaluate).toHaveBeenCalledTimes(1);
  });

  it("shows an error as one line and follows the store", () => {
    seed({ debugPhase: "running", debugError: "Could not attach to 5005" });
    render(<DebugPanel />);
    expect(screen.getByText("Could not attach to 5005").className).toContain("text-destructive");
    act(() => setEditorState({ debugPhase: "stopped", debugError: null }));
    expect(screen.queryByText("Could not attach to 5005")).toBeNull();
    expect(control("Continue").disabled).toBe(false);
  });
});
