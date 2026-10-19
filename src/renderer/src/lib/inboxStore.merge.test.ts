import { describe, expect, it } from "vitest";
import type { InboxItem } from "./githubTasks";
import { mergeInboxStates, type InboxState } from "./inboxStore";

const linearItem = (id: string, updatedAt: string, environmentId: string): InboxItem =>
  ({ provider: "linear", kind: "issue", id, number: 0, title: id, url: "", state: "open", updatedAt, labels: [], assignees: [], draft: false, repo: "", projectPath: "/w", environmentId }) as unknown as InboxItem;

const state = (over: Partial<InboxState> & { linear?: Partial<InboxState["linear"]> }): InboxState => ({
  github: null,
  githubLoaded: true,
  refreshing: false,
  ...over,
  linear: { items: [], fetchedAt: 10, error: null, loading: false, assignedToMe: true, ...(over.linear ?? {}) },
});

describe("mergeInboxStates", () => {
  it("waits for every host, refreshes with any, and lists every host's Linear rows together", () => {
    const states = new Map<string, InboxState>([
      ["local", state({ refreshing: true, linear: { items: [linearItem("A-1", "2026-10-19T10:00:00Z", "local")] } })],
      ["box", state({ githubLoaded: false, linear: { items: [linearItem("B-2", "2026-10-19T12:00:00Z", "box")], fetchedAt: 5 } })],
    ]);
    const merged = mergeInboxStates(states, ["local", "box"]);
    expect(merged.githubLoaded).toBe(false);
    expect(merged.refreshing).toBe(true);
    expect(merged.linear.items.map((i) => i.id)).toEqual(["B-2", "A-1"]);
    expect(merged.linear.fetchedAt).toBe(5);
    expect(merged.linear.assignedToMe).toBe(true);
  });
  it("reports the first host whose GitHub token is not usable, and a host with no state as not loaded", () => {
    const bad = { viewer: null, auth: { state: "missing", message: "gh is not logged in" }, fetchedAt: null, refreshing: false, repos: [] } as unknown as InboxState["github"];
    const states = new Map<string, InboxState>([["local", state({ github: bad })]]);
    expect(mergeInboxStates(states, ["local"]).githubAuthMessage).toBe("gh is not logged in");
    expect(mergeInboxStates(states, ["local", "ghost"]).githubLoaded).toBe(false);
    expect(mergeInboxStates(new Map(), []).githubLoaded).toBe(false);
  });
});
