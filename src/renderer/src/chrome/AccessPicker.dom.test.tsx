// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccessPicker } from "./AccessPicker";

afterEach(cleanup);

async function openMenu() {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: "Permission mode: Supervised" }));
  });
}

describe("AccessPicker", () => {
  it("Escape leaves the focus on its trigger and the field alone", async () => {
    const onClose = vi.fn();
    render(<AccessPicker value="supervised" onChange={() => {}} onClose={onClose} />);
    const trigger = screen.getByRole("combobox", { name: "Permission mode: Supervised" });
    await openMenu();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("Supervised says what its rules do: read-only commands run, edits and changing commands ask", async () => {
    render(<AccessPicker value="supervised" onChange={() => {}} onClose={() => {}} />);
    await openMenu();
    const option = screen.getByRole("option", { name: /Supervised/ });
    expect(option.textContent).toContain("Ask before edits and commands that change things.");
    expect(option.textContent).not.toContain("file changes");
  });

  it("offers one mode per policy, and a thread stored as auto reads Auto-accept edits", async () => {
    render(<AccessPicker value="auto" onChange={() => {}} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Permission mode: Auto-accept edits" }));
    });
    const names = screen.getAllByRole("option").map((o) => o.querySelector("span > span")?.textContent);
    expect(names).toEqual(["Supervised", "Auto-accept edits", "Full access"]);
    expect(document.body.textContent).not.toContain("AI reviewer");
  });

  it("a pick hands the focus to the field", async () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(<AccessPicker value="supervised" onChange={onChange} onClose={onClose} />);
    await openMenu();
    const option = screen.getByRole("option", { name: /Full access/ });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.mouseDown(option);
      fireEvent.pointerUp(option, { pointerType: "mouse" });
      fireEvent.mouseUp(option);
      fireEvent.click(option);
    });
    expect(onChange).toHaveBeenCalledWith("full-access");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
