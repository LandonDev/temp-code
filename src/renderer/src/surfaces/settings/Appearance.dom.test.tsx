// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearancePage } from "./Appearance";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
});
afterEach(cleanup);

async function choose(trigger: string, option: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: trigger }));
  });
  const item = await screen.findByRole("option", { name: option });
  await act(async () => {
    fireEvent.pointerDown(item, { pointerType: "mouse" });
    fireEvent.click(item);
  });
}

describe("Appearance", () => {
  it("is two rows: the theme and the editor's type size", () => {
    render(<AppearancePage />);
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Theme" }).textContent).toContain("Dark");
    expect(screen.getByRole("combobox", { name: "Editor font size" }).textContent).toContain("13px");
  });

  it("applies Light when chosen", async () => {
    render(<AppearancePage />);
    await choose("Theme", "Light");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
    expect(localStorage.getItem("monocode.colorScheme")).toBe("light");
  });

  it("saves the editor's type size", async () => {
    render(<AppearancePage />);
    await choose("Editor font size", "14px");
    expect(localStorage.getItem("monocode.editorFontSize")).toBe("14");
    expect(document.documentElement.style.getPropertyValue("--font-size-code")).toBe("14px");
  });
});
