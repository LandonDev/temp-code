// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Heading, Input, Row, SecondaryButton, Segmented, Select, Toggle } from "./settingsBits";

vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

afterEach(cleanup);

describe("settingsBits shim", () => {
  it("keeps Heading a level-two heading", () => {
    render(<Heading title="Linear" />);
    expect(screen.getByRole("heading", { level: 2, name: "Linear" })).toBeTruthy();
  });

  it("draws Row as a page row with its control", () => {
    render(
      <Row label="Sounds" description="Short cues">
        <SecondaryButton onClick={() => {}}>Test</SecondaryButton>
      </Row>,
    );
    const row = document.querySelector("[data-slot=page-row]");
    expect(row?.textContent).toContain("Sounds");
    expect(row?.textContent).toContain("Short cues");
    expect(screen.getByRole("button", { name: "Test" }).dataset.variant).toBe("secondary");
  });

  it("keeps Toggle a named switch that reports", () => {
    const onChange = vi.fn();
    render(<Toggle label="Zen mode" on={false} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Zen mode" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("keeps Segmented a radiogroup", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Enter"
        value="queue"
        options={[
          { value: "queue", label: "Queue" },
          { value: "steer", label: "Steer" },
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Enter" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Queue" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Steer" }));
    expect(onChange).toHaveBeenCalledWith("steer");
  });

  it("keeps Select a native combobox driven by change events", () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Model"
        value="a"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("maps danger to the destructive button and keeps Input a textbox", () => {
    render(
      <>
        <SecondaryButton danger onClick={() => {}}>
          Remove
        </SecondaryButton>
        <Input aria-label="Key" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Remove" }).dataset.variant).toBe("destructive");
    expect(screen.getByRole("textbox", { name: "Key" }).dataset.slot).toBe("input");
  });
});
