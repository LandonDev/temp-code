// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddonRow } from "@shared/contract-addons";
import { expectModalShape } from "../../../chrome/modalShape.testkit";
import { fakeStoreHost } from "../storeHost.testkit";

vi.mock("../../../components/choice-select", async () => await import("../../../components/choice-select-body"));

const { AddonDialog } = await import("./AddonDialog");

afterEach(cleanup);

const WORKSPACES = [{ id: "ws_1", name: "temp-code" }];
const github: AddonRow = {
  id: "ad_github000001",
  name: "github",
  workspaceId: null,
  description: "Issues",
  spec: { transport: "stdio", command: "npx", args: ["-y", "server-github"], env: ["GITHUB_TOKEN"], auth: "fields" },
  enabled: false,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 1,
};

function open(row: AddonRow | null, host = fakeStoreHost({ addons: [github] })) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<AddonDialog link={host.link} row={row} workspaces={WORKSPACES} onClose={onClose} onSaved={onSaved} />);
  const dialog = screen.getByRole("dialog");
  return { host, dialog, onSaved, onClose };
}

const type = (dialog: HTMLElement, label: string, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
const press = (dialog: HTMLElement, name: string) => fireEvent.click(within(dialog).getByRole("button", { name }));
async function submit(dialog: HTMLElement, verb: string) {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: verb }));
  });
}

describe("AddonDialog", () => {
  it("has the one dialog shape, titled for a new add-on or the one it edits", () => {
    const { dialog } = open(null);
    expectModalShape(dialog);
    expect(within(dialog).getByRole("heading").textContent).toBe("New add-on");
    cleanup();
    expect(within(open(github).dialog).getByRole("heading").textContent).toBe("Edit github");
  });

  it("sends a command's spec with a fresh ad_ id", async () => {
    const { host, dialog, onSaved } = open(null);
    type(dialog, "Name", "linear");
    type(dialog, "Command", "npx");
    type(dialog, "Arguments", "-y\n\nlinear-mcp\n");
    type(dialog, "Variables", "LINEAR_KEY, LINEAR_ORG");
    press(dialog, "Key");
    await submit(dialog, "Add");
    const [sent] = host.sent("addons.set") as { addon: AddonRow }[];
    expect(sent.addon.id).toMatch(/^ad_[A-Za-z0-9_-]{12}$/);
    expect(sent.addon).toEqual({
      id: sent.addon.id,
      name: "linear",
      workspaceId: null,
      description: "",
      spec: { transport: "stdio", command: "npx", args: ["-y", "linear-mcp"], env: ["LINEAR_KEY", "LINEAR_ORG"], auth: "fields" },
      enabled: true,
    });
    // After the exit: the host's row, new.
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: sent.addon.id, name: "linear" }), true);
  });

  it("sends an address's spec, scoped and limited to one kind of host", async () => {
    const { host, dialog } = open(null);
    type(dialog, "Name", "mobbin");
    press(dialog, "Address");
    type(dialog, "Address", "https://api.mobbin.com/mcp");
    press(dialog, "Sign in");
    press(dialog, "Macs only");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("combobox", { name: "Where" }));
    });
    await act(async () => {
      const option = await screen.findByRole("option", { name: "temp-code" });
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    await submit(dialog, "Add");
    const [sent] = host.sent("addons.set") as { addon: AddonRow }[];
    expect(sent.addon).toMatchObject({
      name: "mobbin",
      workspaceId: "ws_1",
      spec: { transport: "http", url: "https://api.mobbin.com/mcp", headers: [], auth: "oauth", platforms: ["darwin"] },
    });
  });

  it("puts the host's refusal of a taken name on the red line and keeps the host's row", async () => {
    const { host, dialog, onSaved } = open(null);
    type(dialog, "Name", "github");
    type(dialog, "Command", "uvx");
    await submit(dialog, "Add");
    expect(within(dialog).getByText("An add-on named github already exists there")).toBeTruthy();
    expect(host.state.addons).toEqual([github]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("offers no sign-in for a command, and says why", () => {
    const { dialog } = open(null);
    const signIn = within(dialog).getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
    expect(signIn.disabled || signIn.getAttribute("aria-disabled") === "true" || signIn.hasAttribute("data-disabled")).toBe(true);
    expect(signIn.closest("[data-choice-note]")).not.toBeNull();
  });

  it("checks the name and the spec before sending anything", async () => {
    const { host, dialog } = open(null);
    type(dialog, "Name", "Bad Name");
    await submit(dialog, "Add");
    expect(within(dialog).getByText("Lowercase letters, digits and dashes, 20 at most")).toBeTruthy();
    type(dialog, "Name", "leaky");
    type(dialog, "Command", "npx");
    type(dialog, "Arguments", "--token=ghp_abcdefghijklmnopqrstuvwxyz0123");
    await submit(dialog, "Add");
    expect(within(dialog).getByText(/^Args\[0\] looks like a secret/)).toBeTruthy();
    expect(host.sent("addons.set")).toEqual([]);
  });

  it("shows any other refusal of the host", async () => {
    const host = fakeStoreHost({ addons: [github] });
    host.state.refuse.set("addons.set", "refused: grants of github live on box; it is offline");
    const { dialog } = open(github, host);
    await submit(dialog, "Save");
    expect(within(dialog).getByText("Grants of github live on box; it is offline")).toBeTruthy();
  });

  it("keeps an edit's id and on/off", async () => {
    const { host, dialog } = open(github);
    expect((within(dialog).getByLabelText("Arguments") as HTMLTextAreaElement).value).toBe("-y\nserver-github");
    type(dialog, "Description", "Issues and pull requests");
    await submit(dialog, "Save");
    const [sent] = host.sent("addons.set") as { addon: AddonRow }[];
    expect(sent.addon).toMatchObject({ id: github.id, enabled: false, description: "Issues and pull requests" });
  });

  it("holds the dialog while a save is in flight", async () => {
    const host = fakeStoreHost({ addons: [github] });
    host.state.silent.add("addons.set");
    const { dialog, onClose } = open(github, host);
    await submit(dialog, "Save");
    await act(async () => fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("says what a command and an address do, in the approval card's words", () => {
    const { dialog } = open(null);
    const note = () => dialog.querySelector("[data-footer-note]")!.textContent;
    expect(note()).toBe("It runs as you on every host that starts it.");
    press(dialog, "Address");
    expect(note()).toBe("Its tools send requests to this address.");
  });
});
