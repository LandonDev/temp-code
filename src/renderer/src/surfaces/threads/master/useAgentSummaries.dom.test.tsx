// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionStore } from "../../../lib/tcserver/store";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { boardLayout, useAgentSummaries } from "./useMasterModel";

const meta = (id: string, parentId: string | null, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId, masterId: "m", provider: "claude", model: "claude-sonnet-5-5", permission: "edits", title: id,
    cwd: "/repo", environmentId: "local", archived: false, status: "running", createdAt: 0, ...extra }) as SessionMeta;
const push = (m: SessionMeta) => sessionStore.injectPush({ push: "session", session: m }, m.environmentId);

beforeEach(() => {
  sessionStore.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  sessionStore.reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("wires meta flushes to one subtree and prunes a row on a new layout without walking those that stayed", async () => {
  const roots = Array.from({ length: 16 }, (_, i) => meta(`c${i}`, null));
  for (const root of roots) {
    push(root);
    push(meta(`${root.id}-agent`, root.id, { activity: "Reading" }));
  }
  await vi.runOnlyPendingTimersAsync();
  const layoutOf = () => boardLayout("m", sessionStore.metas(), (id) => sessionStore.metaOf(id), [], [], undefined, () => true);
  const children = vi.spyOn(sessionStore, "childrenOf");
  const { result, rerender } = renderHook(({ layout }) => useAgentSummaries("m", layout), { initialProps: { layout: layoutOf() } });
  const summaries = result.current;
  const before = roots.map((root) => summaries.get(root.id));
  children.mockClear();
  await act(async () => {
    push(meta("c7-agent", "c7", { activity: "Editing" }));
    await vi.runOnlyPendingTimersAsync();
  });
  expect(children.mock.calls.map(([id]) => id)).toEqual(["c7", "c7-agent"]);
  expect(summaries.get("c7")?.lines[0].detail).toBe("Editing");
  for (const [i, root] of roots.entries()) if (i !== 7) expect(summaries.get(root.id)).toBe(before[i]);
  children.mockClear();
  await act(async () => {
    push(meta("unrelated", null, { masterId: "other" }));
    await vi.runOnlyPendingTimersAsync();
  });
  expect(children).not.toHaveBeenCalled();
  await act(async () => {
    push(meta("c7", null, { archived: true }));
    await vi.runOnlyPendingTimersAsync();
  });
  children.mockClear();
  rerender({ layout: layoutOf() });
  expect(result.current).toBe(summaries);
  expect(summaries.get("c7")).toBeNull();
  expect(children).not.toHaveBeenCalled();
});
