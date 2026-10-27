// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const logos = vi.hoisted(() => ({
  pickImageFile: vi.fn(async () => "/Users/me/logo.png"),
  setProjectLogo: vi.fn(async () => "/data/logos/app.png"),
  clearProjectLogo: vi.fn(async () => {}),
}));
vi.mock("../lib/projectLogos", () => ({ ...logos, projectLogoSrc: (path: string | null) => path }));

import { PROJECT_MASCOTS } from "../lib/projectMascots";
import { CustomizeGroupDialog } from "./CustomizeGroupDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(over: Partial<Parameters<typeof CustomizeGroupDialog>[0]> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onLogoChange = vi.fn();
  render(
    <CustomizeGroupDialog
      environmentId="local"
      groupId="app"
      label="app"
      colorIndex={null}
      customColor={null}
      currentColor="#888888"
      logoPath={null}
      logoProject="app"
      mascotName={null}
      mascotProject="app"
      onSave={onSave}
      onLogoChange={onLogoChange}
      onClose={onClose}
      {...over}
    />,
  );
  return { onSave, onClose, onLogoChange };
}

describe("CustomizeGroupDialog", () => {
  it("names the project or group it customizes under its title", () => {
    open({ label: "Alpha" });
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Alpha");
  });

  it("Save applies the name, the colour and the mascot together", async () => {
    const { onSave, onClose } = open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Colour 3" }));
    const mascot = PROJECT_MASCOTS[1]!.name;
    fireEvent.click(screen.getByRole("button", { name: `Mascot ${mascot}` }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: "Alpha", colorIndex: 2, customColor: null, mascot }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("the first colour saves as the default, a custom one as its hex", async () => {
    const { onSave } = open({ colorIndex: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Colour 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave.mock.calls[0]?.[0]).toMatchObject({ colorIndex: null, customColor: null }));
    cleanup();
    const second = open();
    fireEvent.click(screen.getByRole("button", { name: "Custom colour" }));
    fireEvent.change(screen.getByLabelText("Hex color"), { target: { value: "#123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(second.onSave.mock.calls[0]?.[0]).toMatchObject({ colorIndex: null, customColor: "#123456" }));
  });

  it("an emptied Name saves empty, clearing the name back to the project's own", async () => {
    const { onSave } = open({ label: "Alpha" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave.mock.calls[0]?.[0]).toMatchObject({ name: "" }));
  });

  it("Cancel applies nothing", async () => {
    const { onSave, onClose } = open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(logos.pickImageFile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    expect(logos.setProjectLogo).not.toHaveBeenCalled();
  });

  it("a picked logo is saved only on Save; Remove clears it on Save", async () => {
    const { onLogoChange } = open();
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy());
    expect(logos.setProjectLogo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(logos.setProjectLogo).toHaveBeenCalledWith("local", "app", "/Users/me/logo.png"));
    expect(onLogoChange).toHaveBeenCalled();
    cleanup();
    open({ logoPath: "/data/logos/app.png" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(logos.clearProjectLogo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(logos.clearProjectLogo).toHaveBeenCalledWith("local", "app"));
  });
});
