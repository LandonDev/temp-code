// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@shared/events";

const state = vi.hoisted(() => ({
  projects: [] as { path: string }[],
  metas: [] as Record<string, unknown>[],
  filters: { showArchived: false },
  saveFilters: vi.fn(),
}));

vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/recents", () => ({
  loadArchivedProjects: () => state.projects,
  subscribeArchivedProjects: () => () => {},
  looksLikeProject: () => false,
}));
vi.mock("../../lib/sessionFilters", () => ({
  loadSessionSidebarFilters: () => state.filters,
  saveSessionSidebarFilters: (f: unknown) => state.saveFilters(f),
}));
vi.mock("../../lib/tcserver/store", () => ({ useSessionMetas: () => state.metas }));
vi.mock("../../lib/tcserver/workspaces", () => ({
  useProjects: () => [
    { id: "p1", name: "Alpha" },
    { id: "p2", name: "Beta" },
  ],
  useWorkspaces: () => [],
  workspaceLabelKey: (_w: unknown, _p: string, fallback: string) => fallback,
}));
vi.mock("../../chrome/RemoveProjectDialog", () => ({
  RemoveProjectDialog: ({ name }: { name: string }) => <div role="dialog">Remove {name}</div>,
}));

const { ArchivePage } = await import("./Archive");

const meta = (id: string, title: string, projectId: string, updatedAt = 1) => ({
  id,
  title,
  projectId,
  provider: "claude",
  archived: true,
  cwd: "/w",
  updatedAt,
});

const handlers = () => ({
  onOpenSession: vi.fn(),
  onArchiveSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onRestoreProject: vi.fn(),
  onDeleteProject: vi.fn(),
});

async function clickDelete(row: HTMLElement, verb = "Delete") {
  await act(async () => {
    fireEvent.click(within(row).getByRole("button", { name: /^More for / }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: `${verb}…` }));
  });
}

const rowOf = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-slot=page-row]")!;

beforeEach(() => {
  state.projects = [];
  state.metas = [];
  state.filters = { showArchived: false };
  state.saveFilters.mockClear();
});
afterEach(cleanup);

describe("Archive page", () => {
  it("shows an empty state for each list", () => {
    render(<ArchivePage {...handlers()} />);
    const lines = [...document.querySelectorAll("[data-slot=page-empty]")].map((p) => p.textContent);
    expect(lines).toEqual(["No archived projects", "No archived threads"]);
  });

  it("shows Restore and ⋯ on a row, with Delete… in the menu", async () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    render(<ArchivePage {...handlers()} />);
    const row = rowOf("Fix the build");
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Restore Fix the build",
      "More for Fix the build",
    ]);
    expect(within(row).queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("a row's actions wait on the shared hover reveal and an open menu holds them, never a click", () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    render(<ArchivePage {...handlers()} />);
    const wrapper = within(rowOf("Fix the build")).getByRole("button", { name: "Restore Fix the build" }).parentElement!.className;
    expect(wrapper).toContain("group-hover/item:delay-(--delay-hover)");
    expect(wrapper).toContain("has-[[data-popup-open]]:opacity-100");
    expect(wrapper).toContain("group-has-focus-visible/item:opacity-100");
    expect(wrapper).not.toContain("focus-within");
  });

  it("restores a thread and opens it", async () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    const h = handlers();
    render(<ArchivePage {...h} />);
    await act(async () => {
      fireEvent.click(within(rowOf("Fix the build")).getByRole("button", { name: "Restore Fix the build" }));
    });
    expect(h.onArchiveSession).toHaveBeenCalledWith("t1", false);
    expect(h.onOpenSession).toHaveBeenCalledWith("t1");
  });

  it("filters by title and project, and says when nothing matches", () => {
    state.metas = [meta("t1", "Fix the build", "p1"), meta("t2", "Write docs", "p2")];
    render(<ArchivePage {...handlers()} />);
    const search = screen.getByRole("searchbox", { name: "Search archived threads" });
    fireEvent.change(search, { target: { value: "beta" } });
    expect(screen.queryByText("Fix the build")).toBeNull();
    expect(screen.getByText("Write docs")).toBeTruthy();
    fireEvent.change(search, { target: { value: "fix" } });
    expect(screen.getByText("Fix the build")).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No archived thread matches")).toBeTruthy();
  });

  it("shows the next hundred on Show more", async () => {
    state.metas = Array.from({ length: 150 }, (_, i) => meta(`t${i}`, `Thread ${i}`, "p1", 1000 - i));
    render(<ArchivePage {...handlers()} />);
    expect(screen.getAllByRole("button", { name: /^Restore / })).toHaveLength(100);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    });
    expect(screen.getAllByRole("button", { name: /^Restore / })).toHaveLength(150);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("deletes a thread only from its confirm", async () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    const h = handlers();
    render(<ArchivePage {...h} />);
    await clickDelete(rowOf("Fix the build"));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Delete Fix the build?");
    expect(h.onDeleteSession).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete thread" }));
    });
    expect(h.onDeleteSession).toHaveBeenCalledWith("t1", { confirmed: true });
    // The thread menu's own confirm: its verb and line, drawn once in the app.
    expect(confirm.textContent).toContain("Its transcript is gone for good.");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("opens the remove dialog for a project's Remove…", async () => {
    state.projects = [{ path: "/w/old" }];
    render(<ArchivePage {...handlers()} />);
    await clickDelete(rowOf("old"), "Remove");
    expect(screen.getByRole("dialog").textContent).toBe("Remove old");
  });

  it("saves the sidebar switch", async () => {
    render(<ArchivePage {...handlers()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Archived in the sidebar" }));
    });
    expect(state.saveFilters).toHaveBeenCalledWith({ showArchived: true });
  });
});
