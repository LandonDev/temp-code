// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTypeChip } from "./ThreadTypeChip";

afterEach(cleanup);

async function open() {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: "Thread type" }));
  });
}

/** Base UI commits a mouse choice only when the press started on the item. */
async function choose(name: RegExp) {
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

describe("ThreadTypeChip", () => {
  it("shows the current type on its trigger", () => {
    render(<ThreadTypeChip value="planning" onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Thread type" }).textContent).toContain("Plan");
  });

  it("lists every type with its hint", async () => {
    render(<ThreadTypeChip value="chat" onChange={() => {}} />);
    await open();
    expect(await screen.findAllByRole("option")).toHaveLength(6);
    expect(screen.getByRole("option", { name: /^Research/ }).textContent).toContain(
      "Investigate with parallel explorers, produce a cited report",
    );
  });

  it("calls onChange with the type picked and onClose as it closes", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<ThreadTypeChip value="chat" onChange={onChange} onClose={onClose} />);
    await open();
    expect(onClose).not.toHaveBeenCalled();
    await choose(/^Implement/);
    expect(onChange).toHaveBeenCalledWith("implementation");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose without onChange when closed on Escape", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<ThreadTypeChip value="chat" onChange={onChange} onClose={onClose} />);
    await open();
    const listbox = await screen.findByRole("listbox");
    await act(async () => {
      fireEvent.keyDown(listbox, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
