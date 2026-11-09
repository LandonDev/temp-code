// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Skill } from "@shared/contract-skills";
import { fakeStoreHost, type FakeStoreHost } from "../storeHost.testkit";

const h = vi.hoisted(() => ({ cut: new Set<string>() }));

vi.mock("../../../components/choice-select", async () => await import("../../../components/choice-select-body"));
vi.mock("../../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../../lib/connection/status", () => ({ useEnvironmentStatuses: () => new Map() }));
vi.mock("../../../lib/connection", () => ({ registry: { primary: () => null } }));
vi.mock("../../../lib/tcserver/workspaces", () => ({ useWorkspaces: () => [{ id: "ws_1", name: "temp-code", environmentId: "local" }] }));
// jsdom lays nothing out: a description is cut when the test says so.
vi.mock("../../../components/tip", async (original) => ({
  ...(await original<typeof import("../../../components/tip")>()),
  useTruncated: (text: string) => ({ ref: () => {}, cut: h.cut.has(text) }),
}));
vi.mock("../../chunks", async (original) => ({
  ...(await original<typeof import("../../chunks")>()),
  editorChunk: { surface: () => (props: { value: string; label: string }) => <textarea aria-label={props.label} value={props.value} readOnly /> },
}));

const { SkillsBody } = await import("./SkillsPage");
const { Page } = await import("../../../components/page");
const { ConfirmHost } = await import("../../../chrome/ConfirmDialog");
const { menuChunk } = await import("../../chunks");
const { warmMenus } = await import("../../../chrome/menuRows");
const { NO_ANSWER } = await import("../../../lib/connection/openRead");
const { tooltipChunk, warmTooltips } = await import("../../../components/ui/tooltip");

beforeAll(async () => {
  await menuChunk.load();
  warmMenus();
  await tooltipChunk.load();
  warmTooltips();
});
const tipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
afterEach(() => {
  cleanup();
  h.cut.clear();
});

const LONG = "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify or harden a frontend interface";
const skill = (over: Partial<Skill>): Skill => ({
  id: `sk_${over.name}`,
  name: "x",
  workspaceId: null,
  description: "Does a thing",
  harnesses: "all",
  enabled: true,
  version: 1,
  digest: "d",
  bytes: 10,
  fileCount: 1,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 10,
  files: [{ path: "SKILL.md", text: `---\nname: ${over.name}\ndescription: Does a thing\n---\n` }],
  ...over,
});
const impeccable = skill({ name: "impeccable", description: LONG, harnesses: "all", version: 3, writtenBy: { kind: "thread", sessionId: "s", environmentId: "local", title: "Polish the rail" } });
const tidy = skill({ name: "tidy", workspaceId: "ws_1", harnesses: ["codex"], updatedAt: 20 });
const seeded = () => fakeStoreHost({ skills: [tidy, impeccable] });

const flush = () => act(async () => {});
async function show(host: FakeStoreHost) {
  render(
    <>
      <Page title="Skills">
        <SkillsBody link={host.link} />
      </Page>
      <ConfirmHost />
    </>,
  );
  await flush();
}
const rowOf = (name: string) => document.querySelector<HTMLElement>(`[data-skill="${name}"]`);
async function menu(name: string) {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: `${name} actions` })));
  return screen.findByRole("menu");
}

describe("Settings → Skills", () => {
  it("draws rows in their shape while the host is silent", async () => {
    const host = seeded();
    host.state.silent.add("skills.list");
    await show(host);
    expect(document.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(3);
  });

  it("says the host did not answer with Retry, and Retry lands the rows", async () => {
    const host = seeded();
    host.state.refuse.set("skills.list", NO_ANSWER);
    await show(host);
    expect(screen.getByRole("alert").textContent).toBe(NO_ANSWER);
    host.state.refuse.delete("skills.list");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(rowOf("tidy")).toBeTruthy();
  });

  it("says No skills for an empty host", async () => {
    await show(fakeStoreHost());
    expect(screen.getByText("No skills")).toBeTruthy();
  });

  it("says each skill's CLIs, scope, version and thread writer, sorted by name", async () => {
    await show(seeded());
    expect([...document.querySelectorAll("[data-skill]")].map((r) => r.getAttribute("data-skill"))).toEqual(["impeccable", "tidy"]);
    expect(rowOf("impeccable")!.textContent).toContain("Claude, Codex and Muse");
    expect(rowOf("impeccable")!.textContent).toContain("Every workspace");
    expect(rowOf("impeccable")!.textContent).toContain("v3");
    expect(rowOf("impeccable")!.textContent).toContain("written by Polish the rail");
    expect(rowOf("tidy")!.textContent).toContain("Codex");
    expect(rowOf("tidy")!.textContent).toContain("temp-code");
    expect(rowOf("tidy")!.textContent).not.toContain("written by");
  });

  it("says where the copy lives, and turns every control off while it is offline", async () => {
    const host = seeded();
    host.state.home = { name: "box", online: false };
    await show(host);
    expect(screen.getByText("box is offline")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "tidy" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "tidy actions" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit tidy" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New skill…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("folds the skills push in", async () => {
    const host = seeded();
    await show(host);
    const { files: _files, ...meta } = tidy;
    act(() => host.push({ push: "skills", skills: [meta] }));
    expect(rowOf("impeccable")).toBeNull();
    expect(rowOf("tidy")).toBeTruthy();
  });

  it("flips a skill by reading it whole, then writing it with the updatedAt it was listed at", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "tidy" })));
    expect(host.sent("skills.get")).toEqual([{ id: "sk_tidy" }]);
    expect(host.sent("skills.set")).toEqual([
      { skill: { id: "sk_tidy", name: "tidy", workspaceId: "ws_1", harnesses: ["codex"], enabled: false, files: tidy.files }, expectUpdatedAt: 20 },
    ]);
    expect(screen.getByRole("switch", { name: "tidy" }).getAttribute("aria-checked")).toBe("false");
  });

  it("flips back with the host's reason when the skill moved since it was listed", async () => {
    const host = seeded();
    await show(host);
    host.state.skills = [{ ...tidy, updatedAt: 99 }, impeccable];
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "tidy" })));
    expect(screen.getByRole("switch", { name: "tidy" }).getAttribute("aria-checked")).toBe("true");
    expect(rowOf("tidy")!.textContent).toContain("Tidy changed since it was read");
  });

  it("puts a cut description whole on the open control's tooltip, and no tooltip on one that fits", async () => {
    h.cut.add(LONG);
    await show(seeded());
    const open = screen.getByRole("button", { name: "Edit impeccable" });
    expect(open.closest("[data-slot=page-row]")!.querySelector("[data-skill-description]")!.className).toContain("truncate");
    expect(open.getAttribute("data-slot")).toBe("tooltip-trigger");
    fireEvent.pointerEnter(open);
    fireEvent.focus(open);
    await waitFor(() => expect(tipText()).toBe(LONG), { timeout: 2000 });
    // The one that fits mounts no tooltip trigger at all.
    expect(screen.getByRole("button", { name: "Edit tidy" }).getAttribute("data-slot")).not.toBe("tooltip-trigger");
  });

  it("removes a skill once the confirm says so, with the updatedAt it was listed at", async () => {
    const host = seeded();
    await show(host);
    await act(async () => fireEvent.click(within(await menu("tidy")).getByRole("menuitem", { name: "Remove…" })));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Remove the skill tidy");
    expect(confirm.textContent).toContain("Threads that start from now no longer get it.");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Remove" })));
    expect(host.sent("skills.remove")).toEqual([{ id: "sk_tidy", expectUpdatedAt: 20 }]);
    expect(rowOf("tidy")).toBeNull();
  });

  it("puts New skill… on the title line, and opens Edit… from a row's click", async () => {
    await show(seeded());
    const add = screen.getByRole("button", { name: "New skill…" });
    expect(add.closest("[data-slot=page-actions]")).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Edit tidy" })));
    expect(within(screen.getByRole("dialog")).getByRole("heading").textContent).toBe("Edit tidy");
  });
});
