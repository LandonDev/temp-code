// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";
import { Field, FieldRow } from "./DialogField";

afterEach(cleanup);

describe("Field", () => {
  it("wires the label and the hint to the control", () => {
    render(
      <Field label="Name" hint="Shown in the rail.">
        <Input defaultValue="alpha" />
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("Shown in the rail.").id);
  });

  it("keeps a control's own id and renders no hint without one", () => {
    const { container } = render(
      <Field label="Branch" aside={<span>12 words</span>}>
        <Input id="branch-field" />
      </Field>,
    );
    expect(screen.getByLabelText("Branch").id).toBe("branch-field");
    expect(screen.getByLabelText("Branch").hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getByText("12 words")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });
});

describe("FieldRow", () => {
  it("puts the control at the row's end, labelled by the row's title", () => {
    const { container } = render(
      <FieldRow label="Apply to new threads" description="Kept, but nothing is prepended.">
        <Switch checked={false} />
      </FieldRow>,
    );
    const row = container.querySelector("[data-slot=dialog-field-row]")!;
    expect(row.lastElementChild?.getAttribute("data-slot")).toBe("item-actions");
    expect(screen.getByRole("switch", { name: "Apply to new threads" })).toBeTruthy();
    expect(screen.getByText("Kept, but nothing is prepended.")).toBeTruthy();
  });
});
