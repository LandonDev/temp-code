// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow, AddonSpec } from "@shared/contract-addons";
import { GRANT_PROBE_REFUSED } from "@shared/addonGrantWords";
import { expectModalShape } from "../../../chrome/modalShape.testkit";
import { fakeStoreHost } from "../storeHost.testkit";
import { AddonKeyDialog } from "./AddonKeyDialog";

afterEach(cleanup);

const fields: AddonSpec = { transport: "http", url: "https://x.example/mcp", headers: ["X-Api-Key", "X-Org"], auth: "fields" };
const oauth: AddonSpec = { transport: "http", url: "https://mcp.example.com/mcp", headers: ["X-Team"], auth: "oauth" };
const row = (spec: AddonSpec): AddonRow => ({
  id: "ad_key000000001",
  name: "example",
  workspaceId: null,
  description: "",
  spec,
  enabled: true,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 1,
});
const grant = (set: Record<string, boolean>, over: Partial<AddonGrantView> = {}): AddonGrantView => ({
  addonId: "ad_key000000001",
  fields: Object.entries(set).map(([name, value]) => ({ name, set: value })),
  oauth: null,
  signIn: null,
  gaps: [],
  ...over,
});

function open(spec: AddonSpec, g: AddonGrantView | null, host = fakeStoreHost()) {
  const onClose = vi.fn();
  const view = render(<AddonKeyDialog link={host.link} row={row(spec)} grant={g} onClose={onClose} />);
  return { host, onClose, view, dialog: screen.getByRole("dialog") };
}
const field = (dialog: HTMLElement, name: string) => within(dialog).getByLabelText(name) as HTMLInputElement;

describe("AddonKeyDialog", () => {
  it("has the one dialog shape, Add key until a value is saved", () => {
    const { dialog } = open(fields, null);
    expectModalShape(dialog);
    expect(within(dialog).getByRole("heading").textContent).toBe("Add key");
    expect(within(dialog).getByText("example")).toBeTruthy();
    cleanup();
    expect(within(open(fields, grant({ "X-Api-Key": true, "X-Org": false })).dialog).getByRole("heading").textContent).toBe("Change key");
  });

  it("asks each value in a password field, a saved one marked Saved and never shown", () => {
    const { dialog } = open(fields, grant({ "X-Api-Key": true, "X-Org": false }));
    expect(field(dialog, "X-Api-Key").type).toBe("password");
    expect(field(dialog, "X-Api-Key").autocomplete).toBe("off");
    expect(field(dialog, "X-Api-Key").placeholder).toBe("Saved");
    expect(field(dialog, "X-Api-Key").value).toBe("");
    expect(field(dialog, "X-Org").placeholder).toBe("");
  });

  it("sends only the names typed, and nothing while nothing is", async () => {
    const { host, dialog, onClose } = open(fields, grant({ "X-Api-Key": true, "X-Org": false }));
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(field(dialog, "X-Org"), { target: { value: "acme" } });
    expect(save.disabled).toBe(false);
    await act(async () => fireEvent.click(save));
    expect(host.sent("addons.grant.setFields")).toEqual([{ id: "ad_key000000001", fields: { "X-Org": "acme" } }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("clears every value with Clear, for a values add-on and for an OAuth one before its first sign-in", async () => {
    const one = open(fields, grant({ "X-Api-Key": true, "X-Org": true }));
    await act(async () => fireEvent.click(within(one.dialog).getByRole("button", { name: "Clear" })));
    expect(one.host.sent("addons.grant.setFields")).toEqual([{ id: "ad_key000000001", fields: { "X-Api-Key": null, "X-Org": null } }]);
    expect(one.onClose).toHaveBeenCalled();
    cleanup();
    const two = open(oauth, grant({ "X-Team": true }, { oauth: { signedIn: false, expiresAt: null, refreshedBy: null, refused: false } }));
    await act(async () => fireEvent.click(within(two.dialog).getByRole("button", { name: "Clear" })));
    expect(two.host.sent("addons.grant.setFields")).toEqual([{ id: "ad_key000000001", fields: { "X-Team": null } }]);
    expect(two.host.sent("addons.grant.clear")).toEqual([]);
  });

  it("offers no Clear while nothing is saved", () => {
    const { dialog } = open(fields, null);
    expect(within(dialog).queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("holds the dialog while a save is in flight", async () => {
    const host = fakeStoreHost();
    host.state.silent.add("addons.grant.setFields");
    const { dialog, onClose } = open(fields, null, host);
    fireEvent.change(field(dialog, "X-Api-Key"), { target: { value: "k" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    await act(async () => fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("puts the probe's refusal on the red line and stays open", async () => {
    const host = fakeStoreHost();
    host.state.refuse.set("addons.grant.setFields", GRANT_PROBE_REFUSED);
    const { dialog, onClose } = open(fields, null, host);
    fireEvent.change(field(dialog, "X-Api-Key"), { target: { value: "k" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(within(dialog).getByText(GRANT_PROBE_REFUSED)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("holds no value across a close and a reopen, and never logs one", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      const sentinel = "sk-sentinel-value-0123456789abcdef";
      const first = open(fields, null);
      fireEvent.change(field(first.dialog, "X-Api-Key"), { target: { value: sentinel } });
      await act(async () => fireEvent.click(within(first.dialog).getByRole("button", { name: "Save" })));
      first.view.unmount();
      const second = open(fields, null);
      expect(field(second.dialog, "X-Api-Key").value).toBe("");
      for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(sentinel);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
