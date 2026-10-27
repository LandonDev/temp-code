// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";
import { CheckRow, Field, FieldRow } from "./DialogField";

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

describe("CheckRow", () => {
  it("is a checkbox named by its label; a disabled one does not change", () => {
    const set = vi.fn();
    render(
      <>
        <CheckRow label="Remove the worktree folder" checked onCheckedChange={set} />
        <CheckRow label="Delete origin/x" checked={false} disabled onCheckedChange={set} />
      </>,
    );
    const box = screen.getByRole("checkbox", { name: "Remove the worktree folder" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box);
    expect(set).toHaveBeenCalledWith(false, expect.anything());
    set.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete origin/x" }));
    expect(set).not.toHaveBeenCalled();
  });
});

describe("error lines", () => {
  it("a Field's error takes the hint's place, in red, and marks the control invalid", () => {
    render(
      <Field label="Name" hint="Shown in the rail." error="A name is required.">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    const line = screen.getByText("A name is required.");
    expect(input.getAttribute("aria-describedby")).toBe(line.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(line.className).toContain("text-destructive");
    expect(screen.queryByText("Shown in the rail.")).toBeNull();
  });

  it("a FieldRow's error sits under its description and describes the control", () => {
    render(
      <FieldRow label="Apply to new threads" description="Kept, but nothing is prepended." error="Saving failed.">
        <Switch checked={false} />
      </FieldRow>,
    );
    const control = screen.getByRole("switch", { name: "Apply to new threads" });
    expect(control.getAttribute("aria-describedby")).toBe(screen.getByText("Saving failed.").id);
    expect(screen.getByText("Kept, but nothing is prepended.")).toBeTruthy();
  });
});
