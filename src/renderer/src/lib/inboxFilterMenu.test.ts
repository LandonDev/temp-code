import { describe, expect, it } from "vitest";
import { inboxFilterMenuRows } from "./inboxFilterMenu";
import { DEFAULT_INBOX_FILTERS, type InboxFilters } from "./inboxFilters";

const workspaces = [
  { id: "w1", name: "web", logoPath: null },
  { id: "w2", name: "docs", logoPath: "/logo.png" },
];

function labels(rows: ReturnType<typeof inboxFilterMenuRows>): string[] {
  return rows.map((r) => (r.kind === "label" ? `# ${r.text}` : r.kind === "separator" ? "---" : `${r.checked ? "[x]" : "[ ]"} ${r.label}`));
}

describe("inboxFilterMenuRows", () => {
  it("lists Mine, Status, Time, Type and Workspaces on the GitHub tab", () => {
    const rows = inboxFilterMenuRows({ source: "github", filters: DEFAULT_INBOX_FILTERS, workspaces, onChange: () => undefined });
    expect(labels(rows)).toEqual([
      "# Mine",
      "[ ] Authored by me",
      "[ ] Assigned to me",
      "[ ] Review requested",
      "# Status",
      "[ ] Open",
      "[ ] Draft",
      "[ ] Closed",
      "[ ] Merged",
      "# Time",
      "[x] All time",
      "[ ] Today",
      "[ ] Last 7 days",
      "[ ] Last 30 days",
      "# Type",
      "[x] Issues",
      "[x] Pull requests",
      "# Workspaces",
      "[x] web",
      "[x] docs",
    ]);
    const docs = rows.find((r) => r.kind === "item" && r.key === "workspace:w2");
    expect(docs && docs.kind === "item" ? docs.icon : null).toEqual({ workspace: workspaces[1] });
  });

  it("keeps only Assigned to me on the Linear tab and hides GitHub sections", () => {
    const rows = inboxFilterMenuRows({ source: "linear", filters: DEFAULT_INBOX_FILTERS, workspaces, onChange: () => undefined });
    expect(labels(rows)).toEqual([
      "[ ] Assigned to me",
      "# Status",
      "[ ] Open",
      "[ ] Closed",
      "# Time",
      "[x] All time",
      "[ ] Today",
      "[ ] Last 7 days",
      "[ ] Last 30 days",
    ]);
  });

  it("hides the Workspaces section when none are offered", () => {
    const rows = inboxFilterMenuRows({ source: "github", filters: DEFAULT_INBOX_FILTERS, workspaces: [], onChange: () => undefined });
    expect(labels(rows)).not.toContain("# Workspaces");
  });

  it("toggles mine flags and workspaces, and clears everything", () => {
    let last: InboxFilters | null = null;
    const onChange = (f: InboxFilters) => {
      last = f;
    };
    const filters: InboxFilters = {
      ...DEFAULT_INBOX_FILTERS,
      mine: { authored: true, assigned: false, reviewRequested: false },
      hiddenWorkspaceIds: ["w1"],
    };
    const rows = inboxFilterMenuRows({ source: "github", filters, workspaces, onChange });
    const click = (key: string) => {
      const row = rows.find((r) => r.kind === "item" && r.key === key);
      if (!row || row.kind !== "item") throw new Error(`no row ${key}`);
      row.onClick();
      return row;
    };
    expect(click("mine:authored").checked).toBe(true);
    expect(last!.mine).toEqual({ authored: false, assigned: false, reviewRequested: false });
    click("mine:reviewRequested");
    expect(last!.mine).toEqual({ authored: true, assigned: false, reviewRequested: true });
    expect(click("workspace:w1").checked).toBe(false);
    expect(last!.hiddenWorkspaceIds).toEqual([]);
    click("workspace:w2");
    expect(last!.hiddenWorkspaceIds).toEqual(["w1", "w2"]);
    expect(labels(rows)).toContain("---");
    click("clear");
    expect(last).toEqual(DEFAULT_INBOX_FILTERS);
  });
});
