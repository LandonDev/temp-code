// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceToggle } from "./choice-toggle";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma", disabled: true, note: "Not here" },
];

afterEach(cleanup);

const group = () => screen.getByRole("group", { name: "Pick" });
const button = (name: string) => within(group()).getByRole("button", { name }) as HTMLButtonElement;

describe("ChoiceToggle", () => {
  it("presses the chosen option and reports another", () => {
    const onChange = vi.fn();
    render(<ChoiceToggle label="Pick" value="a" options={OPTIONS} onChange={onChange} />);
    expect(button("Alpha").getAttribute("aria-pressed")).toBe("true");
    expect(button("Beta").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button("Beta"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("keeps the chosen option when it is pressed again", () => {
    const onChange = vi.fn();
    render(<ChoiceToggle label="Pick" value="a" options={OPTIONS} onChange={onChange} />);
    fireEvent.click(button("Alpha"));
    expect(onChange).not.toHaveBeenCalled();
    expect(button("Alpha").getAttribute("aria-pressed")).toBe("true");
  });

  it("disables a choice with a note on a wrapper, never a title=", () => {
    render(<ChoiceToggle label="Pick" value="a" options={OPTIONS} onChange={() => {}} />);
    expect(button("Gamma").disabled).toBe(true);
    expect(button("Gamma").closest("[data-choice-note]")).toBeTruthy();
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("takes its name from a row's label when given one", () => {
    render(
      <>
        <span id="row-label">Host</span>
        <ChoiceToggle label="Pick" aria-labelledby="row-label" value="a" options={OPTIONS} onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole("group", { name: "Host" })).toBeTruthy();
  });
});
