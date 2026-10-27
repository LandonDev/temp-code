// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceSelect } from "./choice-select-body";

const OPTIONS = [
  { value: "", label: "Auto" },
  { value: "idea", label: "IntelliJ IDEA" },
  { value: "code", label: "VS Code" },
];

afterEach(cleanup);

/** Base UI commits a mouse choice only when the press started on the item. */
async function choose(name: string) {
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

async function open(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.click(trigger);
  });
}

describe("ChoiceSelect", () => {
  it("shows the chosen option's label on its trigger", () => {
    render(<ChoiceSelect label="Editor" value="code" options={OPTIONS} onChange={() => {}} />);
    const trigger = screen.getByRole("combobox", { name: "Editor" });
    expect(trigger.textContent).toContain("VS Code");
  });

  it("treats an empty value as an ordinary choice", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ChoiceSelect label="Editor" value="" options={OPTIONS} onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "Editor" });
    expect(trigger.textContent).toContain("Auto");
    rerender(<ChoiceSelect label="Editor" value="idea" options={OPTIONS} onChange={onChange} />);
    await open(trigger);
    await choose("Auto");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("calls onChange with the item chosen", async () => {
    const onChange = vi.fn();
    render(<ChoiceSelect label="Editor" value="" options={OPTIONS} onChange={onChange} />);
    await open(screen.getByRole("combobox", { name: "Editor" }));
    await choose("VS Code");
    expect(onChange).toHaveBeenCalledWith("code");
  });

  it("lists grouped options under their group, ungrouped ones first", async () => {
    render(
      <ChoiceSelect
        label="Build model"
        value=""
        options={[
          { value: "opus", label: "Opus", group: "Claude" },
          { value: "", label: "Same as the plan" },
          { value: "sol", label: "Sol", group: "Codex" },
        ]}
        onChange={() => {}}
      />,
    );
    await open(screen.getByRole("combobox", { name: "Build model" }));
    const list = await screen.findByRole("listbox");
    expect([...list.querySelectorAll("[role=option], [data-slot=select-label]")].map((el) => el.textContent)).toEqual([
      "Same as the plan",
      "Claude",
      "Opus",
      "Codex",
      "Sol",
    ]);
  });
});
