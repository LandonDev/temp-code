// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "./modalShape.testkit";

vi.mock("../lib/harness", () => ({ generateCommitMessage: vi.fn(async () => "Fix the rail order") }));

import { SwitchBranchDialog } from "./SwitchBranchDialog";

afterEach(cleanup);

const open = (over: Partial<Parameters<typeof SwitchBranchDialog>[0]> = {}) => {
  const props = { cwd: "/x", branch: "feature", busy: null, onStash: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn(), ...over };
  render(<SwitchBranchDialog {...props} />);
  return props;
};

describe("SwitchBranchDialog", () => {
  it("ends on the shared footer: Cancel, Commit & switch between, Stash & switch last", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expectModalShape(dialog);
    const footer = dialog.querySelector('[data-slot="dialog-footer"]')!;
    expect([...footer.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Commit & switch", "Stash & switch"]);
    // In a 400px window three verbs wrap onto a second line, never past the edge.
    expect(footer.className).toContain("flex-wrap");
  });

  it("lands focus in the message and commits on ⌘↩", async () => {
    const props = open();
    const field = screen.getByRole("textbox", { name: "Commit message" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByText("Stash or commit them before switching to “feature”.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Commit & switch" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "  Save work  " } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(props.onCommit).toHaveBeenCalledWith("Save work");
  });

  it("Generate fills the message", async () => {
    open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate commit message" }));
    });
    expect((screen.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("Fix the rail order");
  });

  it("Stash & switch stashes; a busy stash shows its spinner and holds every button", () => {
    const props = open();
    fireEvent.click(screen.getByRole("button", { name: "Stash & switch" }));
    expect(props.onStash).toHaveBeenCalledTimes(1);
    cleanup();
    open({ busy: "stash" });
    const stash = screen.getByRole("button", { name: /Stash & switch/ }) as HTMLButtonElement;
    expect(stash.disabled).toBe(true);
    expect(stash.querySelector("[data-slot=spinner], [role=status]")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
