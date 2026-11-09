// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow, AddonStatus } from "@shared/contract-addons";
import { fakeStoreHost, type FakeStoreHost } from "../storeHost.testkit";

vi.mock("../../../components/choice-select", async () => await import("../../../components/choice-select-body"));
vi.mock("../../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../../lib/connection/status", () => ({ useEnvironmentStatuses: () => new Map() }));
vi.mock("../../../lib/connection", () => ({ registry: { primary: () => null } }));
vi.mock("../../../lib/tcserver/workspaces", () => ({ useWorkspaces: () => [{ id: "ws_1", name: "temp-code", environmentId: "local" }] }));

const { AddonsBody } = await import("./AddonsPage");
const { Page } = await import("../../../components/page");
const { ConfirmHost } = await import("../../../chrome/ConfirmDialog");
const { menuChunk } = await import("../../chunks");
const { warmMenus } = await import("../../../chrome/menuRows");
const { NO_ANSWER } = await import("../../../lib/connection/openRead");
const { asWebPage } = await import("../../../test/webMode");

beforeAll(async () => {
  await menuChunk.load();
  warmMenus();
});
afterEach(cleanup);

const base = (over: Partial<AddonRow>): AddonRow => ({
  id: `ad_${over.name}`,
  name: "x",
  workspaceId: null,
  description: "",
  spec: { transport: "stdio", command: "npx", args: [], env: [], auth: "none" },
  enabled: true,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const github = base({ name: "github", spec: { transport: "stdio", command: "npx", args: ["server-github"], env: ["GITHUB_TOKEN"], auth: "fields" }, writtenBy: { kind: "thread", sessionId: "s1", environmentId: "local", title: "Fix the build" } });
const mobbin = base({ name: "mobbin", spec: { transport: "http", url: "https://api.mobbin.com/mcp", headers: [], auth: "oauth" } });
const slack = base({ name: "slack", workspaceId: "ws_1", spec: { transport: "http", url: "https://slack.example/mcp", headers: ["X-Api-Key"], auth: "fields" } });
const local = base({ name: "local", enabled: false });
const at = (state: AddonStatus["state"], over: Partial<AddonStatus> = {}): AddonStatus => ({ state, tools: 0, at: 1, ...over });
const STATUS: Record<string, AddonStatus> = {
  [github.id]: at("ready", { tools: 24 }),
  [mobbin.id]: at("failed", { detail: "Disconnected: socket hang up" }),
  [slack.id]: at("needs-grant", { detail: "Needs values for X-Api-Key" }),
  [local.id]: at("off"),
};
const GRANTS: AddonGrantView[] = [
  { addonId: github.id, fields: [{ name: "GITHUB_TOKEN", set: true }], oauth: null, signIn: null, gaps: [] },
  { addonId: mobbin.id, fields: [], oauth: { signedIn: true, expiresAt: null, refreshedBy: "box", refused: false }, signIn: null, gaps: [] },
];
const seeded = () => fakeStoreHost({ addons: [github, mobbin, slack, local], status: STATUS, grants: GRANTS });

const flush = () => act(async () => {});
async function show(host: FakeStoreHost) {
  render(
    <>
      <Page title="Add-ons">
        <AddonsBody link={host.link} />
      </Page>
      <ConfirmHost />
    </>,
  );
  await flush();
}
const rowOf = (name: string) => document.querySelector<HTMLElement>(`[data-addon="${name}"]`)!;
async function menu(name: string) {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: `${name} actions` })));
  return screen.findByRole("menu");
}
const item = (m: HTMLElement, name: string) => within(m).getByRole("menuitem", { name });

describe("Settings → Add-ons", () => {
  it("draws rows in their shape while the host is silent", async () => {
    const host = seeded();
    host.state.silent.add("addons.list");
    await show(host);
    const skeleton = document.querySelectorAll("[data-slot=page-row-skeleton]");
    expect(skeleton).toHaveLength(3);
    expect(skeleton[0]!.getAttribute("data-control")).toBe("switch");
    expect((screen.getByRole("button", { name: "Add…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the host did not answer with Retry, and Retry lands the rows", async () => {
    const host = seeded();
    host.state.refuse.set("addons.list", NO_ANSWER);
    await show(host);
    expect(screen.getByRole("alert").textContent).toBe(NO_ANSWER);
    host.state.refuse.delete("addons.list");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(rowOf("github")).toBeTruthy();
  });

  it("says No add-ons for an empty host", async () => {
    await show(fakeStoreHost());
    expect(screen.getByText("No add-ons")).toBeTruthy();
  });

  it("says each row's state, scope, grant and writer, sorted by name", async () => {
    await show(seeded());
    expect([...document.querySelectorAll("[data-addon]")].map((r) => r.getAttribute("data-addon"))).toEqual(["github", "local", "mobbin", "slack"]);
    expect(rowOf("github").textContent).toContain("Connected24 tools");
    expect(rowOf("github").textContent).toContain("GITHUB_TOKEN saved");
    expect(rowOf("github").textContent).toContain("written by Fix the build");
    expect(rowOf("mobbin").textContent).toContain("FailedDisconnected: socket hang up");
    // A failure's reason wraps rather than being cut.
    expect(rowOf("mobbin").querySelector("[data-slot=status-mark]")!.className).toContain("**:data-[slot=status-detail]:whitespace-normal");
    expect(rowOf("mobbin").textContent).toContain("signed in");
    expect(rowOf("mobbin").textContent).toContain("refreshed on box");
    expect(rowOf("slack").textContent).toContain("Needs a keyX-Api-Key");
    expect(rowOf("slack").textContent).toContain("temp-code");
    expect(rowOf("local").textContent).toContain("Off");
    expect(rowOf("local").textContent).toContain("Every workspace");
  });

  it("says where the copy lives", async () => {
    const host = seeded();
    host.state.home = { name: "box", online: true };
    await show(host);
    expect(screen.getByText("Saved on box")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "github" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("turns every control off while the home is offline", async () => {
    const host = seeded();
    host.state.home = { name: "box", online: false };
    await show(host);
    expect(screen.getByText("box is offline")).toBeTruthy();
    for (const name of ["github", "local", "mobbin", "slack"]) {
      const row = rowOf(name);
      for (const control of [
        within(row).getByRole("switch", { name }),
        within(row).getByRole("button", { name: `${name} actions` }),
        within(row).getByRole("button", { name: `Edit ${name}` }),
      ])
        expect(control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true").toBe(true);
    }
    expect((screen.getByRole("button", { name: "Add…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("folds the pushes in, all of them when they land before a render", async () => {
    const host = seeded();
    await show(host);
    const linear = base({ name: "linear", spec: { transport: "http", url: "https://mcp.linear.app/mcp", headers: [], auth: "oauth" } });
    act(() => host.push({ push: "addons", addons: [github, mobbin, slack, local, linear] }));
    expect(rowOf("linear").textContent).toContain("Starting");
    act(() => host.push({ push: "addon-status", status: { ...STATUS, [linear.id]: at("ready", { tools: 1 }) } }));
    expect(rowOf("linear").textContent).toContain("Connected1 tool");
    act(() =>
      host.push({ push: "addon-grants", grants: [...GRANTS, { addonId: linear.id, fields: [], oauth: null, signIn: { state: "waiting", since: 1 }, gaps: ["sign-in"] }] }),
    );
    expect(rowOf("linear").textContent).toContain("Signing inWaiting for the browser");
    // Three pushes before one render: each computes from the one before.
    const figma = base({ name: "figma" });
    act(() => {
      host.push({ push: "addons", addons: [github, figma] });
      host.push({ push: "addon-status", status: { [figma.id]: at("ready", { tools: 3 }) } });
      host.push({ push: "addon-grants", grants: [{ addonId: github.id, fields: [{ name: "GITHUB_TOKEN", set: false }], oauth: null, signIn: null, gaps: ["GITHUB_TOKEN"] }] });
    });
    expect([...document.querySelectorAll("[data-addon]")].map((r) => r.getAttribute("data-addon"))).toEqual(["figma", "github"]);
    expect(rowOf("figma").textContent).toContain("Connected3 tools");
    expect(rowOf("github").textContent).not.toContain("saved");
  });

  it("leaves the grant out and its rows off while the grants are unread", async () => {
    const host = seeded();
    host.state.silent.add("addons.grant.list");
    await show(host);
    expect(rowOf("github").textContent).not.toContain("saved");
    const m = await menu("github");
    expect(item(m, "Add key…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => fireEvent.keyDown(m, { key: "Escape" }));
    const m2 = await menu("mobbin");
    expect(item(m2, "Sign in…").getAttribute("aria-disabled")).toBe("true");
  });

  it("says a failed grants read under the rows with its own Retry, the grant rows still off", async () => {
    const host = seeded();
    host.state.refuse.set("addons.grant.list", NO_ANSWER);
    await show(host);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(NO_ANSWER);
    expect(rowOf("slack").compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const m = await menu("github");
    expect(item(m, "Add key…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => fireEvent.keyDown(m, { key: "Escape" }));
    host.state.refuse.delete("addons.grant.list");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(rowOf("github").textContent).toContain("GITHUB_TOKEN saved");
  });

  it("signs an OAuth add-on out with addons.grant.clear", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(item(await menu("mobbin"), "Sign out")));
    expect(host.sent("addons.grant.clear")).toEqual([{ id: mobbin.id }]);
  });

  it("sends the switch and flips it back with the host's reason under the row", async () => {
    const host = seeded();
    await show(host);
    const sw = screen.getByRole("switch", { name: "github" });
    await act(async () => fireEvent.click(sw));
    expect(host.sent("addons.set")).toEqual([{ addon: { id: github.id, name: "github", workspaceId: null, description: "", spec: github.spec, enabled: false } }]);
    expect(rowOf("github").textContent).toContain("Off");
    host.state.refuse.set("addons.set", "refused: addons of every workspace live on box; it is offline");
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "local" })));
    expect(screen.getByRole("switch", { name: "local" }).getAttribute("aria-checked")).toBe("false");
    expect(rowOf("local").textContent).toContain("Addons of every workspace live on box; it is offline");
  });

  it("removes an add-on once the confirm says so", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(item(await menu("slack"), "Remove…")));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Remove the add-on slack");
    expect(host.sent("addons.remove")).toEqual([]);
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Remove" })));
    expect(host.sent("addons.remove")).toEqual([{ id: slack.id }]);
    expect(rowOf("slack")).toBeNull();
  });

  it("signs in on the desktop, and offers no sign-in at /ui", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(item(await menu("mobbin"), "Sign in again…")));
    expect(host.sent("addons.grant.signIn")).toEqual([{ id: mobbin.id }]);
    cleanup();
    const restore = asWebPage();
    try {
      await show(seeded());
      const m = await menu("mobbin");
      expect(within(m).queryByRole("menuitem", { name: /Sign in/ })).toBeNull();
      expect(item(m, "Sign out")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("opens Edit… prefilled from a row's click", async () => {
    await show(seeded());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Edit github" })));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Edit github");
    expect((within(dialog).getByLabelText("Command") as HTMLInputElement).value).toBe("npx");
  });

  it("puts Add… on the title line, and opens Add key… after a new add-on that names values", async () => {
    const host = seeded();
    await show(host);
    const add = screen.getByRole("button", { name: "Add…" });
    expect(add.closest("[data-slot=page-actions]")).not.toBeNull();
    await act(async () => fireEvent.click(add));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "notion" } });
    fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.change(within(dialog).getByLabelText("Variables"), { target: { value: "NOTION_KEY" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Key" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Add" })));
    await flush();
    const key = screen.getByRole("dialog");
    expect(within(key).getByRole("heading").textContent).toBe("Add key");
    expect(within(key).getByLabelText("NOTION_KEY")).toBeTruthy();
    expect(rowOf("notion")).toBeTruthy();
  });
});
